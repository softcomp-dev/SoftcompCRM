/**
 * APLICAR O TRONCO SALVO NA TELA — o worker de voz leva `voip_trunk_settings`
 * ao Asterisk pela ARI e conta o resultado em `voip_trunk_status`.
 *
 * Uma rodada a cada 30 s (e uma no boot): para cada tronco cadastrado, compara
 * o hash da configuração com o que foi aplicado por último. Mudou → empurra os
 * objetos do PJSIP (`lib/voip/tronco-dinamico.ts`) ou, desativado, os remove.
 * Depois pergunta ao Asterisk se a operadora responde (`online`/`offline`).
 *
 * Por que rodada e não evento: o Asterisk pode reiniciar a qualquer momento
 * (atualização, queda), e quem reconcilia é este worker — que reconecta junto.
 * O astdb guarda os objetos entre reinícios, então a rodada quase sempre só
 * confere; o custo é uma leitura de uma tabela pequena a cada 30 s. A espera
 * máxima entre salvar na tela e valer no Asterisk é uma rodada, e a tela diz
 * "pendente" até lá.
 *
 * Só escreve `voip_trunk_status` quando o estado MUDA — conferência que dá o
 * mesmo resultado não gera escrita.
 *
 * A senha é decifrada aqui (a chave `AI_CRED_AES_KEY` é a mesma do app, no
 * `.env` que o compose entrega ao serviço) e vai só para a ARI, na rede interna.
 * Nunca para o log, nunca para o banco: o estado guarda o HASH da forma cifrada.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { apagarObjetoPjsip, estadoDoEndpoint, gravarObjetoPjsip } from "@/lib/voip/ariClient";
import type { TrunkState } from "@/lib/voip/call-vocabulary";
import { hashDoTronco, objetosDoTronco, type TroncoSalvo } from "@/lib/voip/tronco-dinamico";

const supabaseAdmin = createAdminClient();

export const INTERVALO_DA_RODADA_MS = 30_000;

interface LinhaDoTronco extends TroncoSalvo {
  password_tag: string;
}

interface EstadoGravado {
  organization_id: string;
  applied_config_hash: string | null;
  state: TrunkState;
  error: string | null;
}

function mensagemSemSegredo(err: unknown, senha: string | null): string {
  const bruto = err instanceof Error ? err.message : String(err);
  const limpo = senha ? bruto.split(senha).join("***") : bruto;
  return limpo.slice(0, 300);
}

async function gravarEstado(
  anterior: EstadoGravado | undefined,
  orgId: string,
  novo: { state: TrunkState; error: string | null; applied_config_hash?: string | null },
) {
  const hash = novo.applied_config_hash !== undefined ? novo.applied_config_hash : (anterior?.applied_config_hash ?? null);
  const igual =
    anterior && anterior.state === novo.state && anterior.error === novo.error && anterior.applied_config_hash === hash;
  if (igual) return;
  const agora = new Date().toISOString();
  const { error } = await supabaseAdmin.from("voip_trunk_status").upsert(
    {
      organization_id: orgId,
      state: novo.state,
      error: novo.error,
      applied_config_hash: hash,
      ...(novo.applied_config_hash !== undefined ? { applied_at: agora } : {}),
      checked_at: agora,
      updated_at: agora,
    },
    { onConflict: "organization_id" },
  );
  if (error) logger.error("[tronco] falha ao gravar o estado", { organization_id: orgId, err: error.message });
}

/** Uma rodada sobre todos os troncos. Exportada para o teste. Nunca lança. */
export async function rodadaDoTronco(): Promise<void> {
  const { data: troncos, error } = await supabaseAdmin
    .from("voip_trunk_settings")
    .select(
      "organization_id, host, port, username, from_domain, endpoint_name, is_active, password_encrypted, password_iv, password_tag",
    );
  if (error) {
    logger.error("[tronco] falha ao ler os troncos", { err: error.message });
    return;
  }
  const { data: estados } = await supabaseAdmin
    .from("voip_trunk_status")
    .select("organization_id, applied_config_hash, state, error");
  const porOrg = new Map((estados as EstadoGravado[] | null ?? []).map((e) => [e.organization_id, e]));

  for (const t of (troncos ?? []) as LinhaDoTronco[]) {
    const anterior = porOrg.get(t.organization_id);
    const hash = hashDoTronco(t);
    let senha: string | null = null;

    if (anterior?.applied_config_hash !== hash) {
      try {
        if (t.is_active) {
          senha = decryptKey({
            ciphertext: byteaToBuffer(t.password_encrypted),
            iv: byteaToBuffer(t.password_iv),
            tag: byteaToBuffer(t.password_tag),
          });
          // SABOTAGEM: remover este laço = o caso "aplica" de aplicar-tronco.test.ts fica vermelho.
          for (const o of objetosDoTronco(t, senha)) {
            await gravarObjetoPjsip(o.configClass, o.objectType, o.id, o.fields);
          }
          logger.info("[tronco] tronco aplicado no Asterisk", { organization_id: t.organization_id });
        } else {
          for (const o of objetosDoTronco(t, "").reverse()) {
            await apagarObjetoPjsip(o.configClass, o.objectType, o.id);
          }
          logger.info("[tronco] tronco desativado removido do Asterisk", { organization_id: t.organization_id });
          await gravarEstado(anterior, t.organization_id, {
            state: "desligado",
            error: null,
            applied_config_hash: hash,
          });
          continue;
        }
      } catch (err) {
        const motivo = mensagemSemSegredo(err, senha);
        logger.error("[tronco] falha ao aplicar o tronco", { organization_id: t.organization_id, err: motivo });
        await gravarEstado(anterior, t.organization_id, { state: "erro", error: motivo });
        continue;
      }
    } else if (!t.is_active) {
      continue;
    }

    let estado: TrunkState = "offline";
    try {
      estado = (await estadoDoEndpoint(t.endpoint_name)) === "online" ? "online" : "offline";
    } catch {
      estado = "offline";
    }
    await gravarEstado(anterior, t.organization_id, {
      state: estado,
      error: null,
      ...(anterior?.applied_config_hash !== hash ? { applied_config_hash: hash } : {}),
    });
  }
}

/** Liga as rodadas. Devolve o `parar` para o teste e para o desligamento. */
export function iniciarAplicacaoDoTronco(): { parar: () => void } {
  let rodando = false;
  const rodar = async () => {
    if (rodando) return;
    rodando = true;
    try {
      await rodadaDoTronco();
    } catch (err) {
      logger.error("[tronco] rodada falhou", { err: err instanceof Error ? err.message : String(err) });
    } finally {
      rodando = false;
    }
  };
  void rodar();
  const timer = setInterval(() => void rodar(), INTERVALO_DA_RODADA_MS);
  return { parar: () => clearInterval(timer) };
}
