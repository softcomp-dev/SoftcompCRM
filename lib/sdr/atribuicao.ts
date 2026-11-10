/**
 * Atribuição da função SDR a membros da organização.
 *
 * Quem chama (as rotas de `/api/v1/sdr`) já resolveu a organização de fonte
 * confiável (`requireRole`, cookie validado) e passa o client admin: a RLS de
 * `user_organizations` só mostra o próprio vínculo a quem não é admin. Por isso
 * TODA consulta daqui filtra `organization_id` — nunca vem do corpo.
 *
 * ─── Consistência ───────────────────────────────────────────────────────────
 * Marcar é UM `UPDATE` condicional: só grava se o vínculo é da organização,
 * está ativo, tem papel que pode ser SDR e ainda não está marcado. Não há
 * "confere e depois grava": uma revogação ou um rebaixamento que corra junto
 * ou acontece antes (e o UPDATE não casa linha) ou depois (e a marca fica sem
 * efeito pelo cálculo de `permissoes.ts`). Nos dois casos o estado é coerente.
 *
 * Marcar quem já é SDR e desmarcar quem não é são idempotentes: devolvem o
 * estado atual, sem escrever e sem auditar.
 */
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import type { createAdminClient } from "@/lib/supabase/admin";

import { lerConfiguracaoSdr } from "./configuracao";
import type { MembroDaPassagem } from "./passagem";
import { PAPEIS_QUE_PODEM_SER_SDR, type MembroParaPermissao } from "./permissoes";

type Db = ReturnType<typeof createAdminClient>;

const COLUNAS = "user_id, role, revoked_at, sdr_since" as const;

export type ResultadoDeAtribuicao =
  | { tipo: "marcado"; membro: MembroParaPermissao }
  | { tipo: "ja_marcado"; membro: MembroParaPermissao }
  | { tipo: "desmarcado"; membro: MembroParaPermissao }
  | { tipo: "nao_marcado"; membro: MembroParaPermissao }
  | { tipo: "nao_encontrado" }
  | { tipo: "revogado" }
  | { tipo: "papel_insuficiente"; role: string }
  | { tipo: "conflito" }
  | { tipo: "erro"; mensagem: string };

/**
 * Por que um membro NÃO pode ser marcado agora — puro, para a rota e o teste.
 * `null` quando pode (ou quando já está marcado: isso é idempotência, não recusa).
 */
export function recusaDeMarcacao(
  membro: MembroParaPermissao | null,
): Extract<ResultadoDeAtribuicao, { tipo: "nao_encontrado" | "revogado" | "papel_insuficiente" }> | null {
  if (!membro) return { tipo: "nao_encontrado" };
  if (membro.revoked_at !== null) return { tipo: "revogado" };
  if (!(PAPEIS_QUE_PODEM_SER_SDR as readonly string[]).includes(membro.role)) {
    return { tipo: "papel_insuficiente", role: membro.role };
  }
  return null;
}

/** Lê um vínculo da organização (ou `null` se não existe). Usado também pelo cálculo de permissões. */
export async function lerMembro(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ ok: true; membro: MembroParaPermissao | null } | { ok: false; mensagem: string }> {
  const { data, error } = await db
    .from("user_organizations")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, mensagem: error.message };
  return { ok: true, membro: (data as MembroParaPermissao | null) ?? null };
}

/** O interruptor da organização. Falha de leitura NÃO vira "ligado". */
export async function lerFuncaoSdrLigada(
  db: Db,
  orgId: string,
): Promise<{ ok: true; enabled: boolean } | { ok: false; mensagem: string }> {
  const { data, error } = await db.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  if (error || !data) return { ok: false, mensagem: error?.message ?? "organization_not_found" };
  return { ok: true, enabled: lerConfiguracaoSdr(data.settings).enabled };
}

export async function marcarSdr(
  db: Db,
  orgId: string,
  userId: string,
  agora: Date = new Date(),
): Promise<ResultadoDeAtribuicao> {
  const escrita = await db
    .from("user_organizations")
    .update({ sdr_since: agora.toISOString() })
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .in("role", [...PAPEIS_QUE_PODEM_SER_SDR])
    .is("sdr_since", null)
    .select(COLUNAS)
    .maybeSingle();
  if (escrita.error) return { tipo: "erro", mensagem: escrita.error.message };
  if (escrita.data) {
    // Toda escrita no vínculo derruba o snapshot curto do usuário (cerca
    // `acesso-revogado-nao-espera-o-cache`): quem passar a ler a marca pela
    // sessão não pode vê-la até 30 s atrasada.
    invalidarUsuario(userId);
    return { tipo: "marcado", membro: escrita.data as MembroParaPermissao };
  }

  // Nenhuma linha casou: descobrir por quê, lendo o estado atual.
  const lido = await lerMembro(db, orgId, userId);
  if (!lido.ok) return { tipo: "erro", mensagem: lido.mensagem };
  const recusa = recusaDeMarcacao(lido.membro);
  if (recusa) return recusa;
  if (lido.membro!.sdr_since !== null) return { tipo: "ja_marcado", membro: lido.membro! };
  // Elegível e desmarcado AGORA, mas não casou no UPDATE: outra escrita correu
  // no meio. Quem chama pede para tentar de novo — nunca adivinha.
  return { tipo: "conflito" };
}

export async function desmarcarSdr(db: Db, orgId: string, userId: string): Promise<ResultadoDeAtribuicao> {
  const escrita = await db
    .from("user_organizations")
    .update({ sdr_since: null })
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .not("sdr_since", "is", null)
    .select(COLUNAS)
    .maybeSingle();
  if (escrita.error) return { tipo: "erro", mensagem: escrita.error.message };
  if (escrita.data) {
    invalidarUsuario(userId);
    return { tipo: "desmarcado", membro: escrita.data as MembroParaPermissao };
  }

  const lido = await lerMembro(db, orgId, userId);
  if (!lido.ok) return { tipo: "erro", mensagem: lido.mensagem };
  if (!lido.membro) return { tipo: "nao_encontrado" };
  if (lido.membro.sdr_since === null) return { tipo: "nao_marcado", membro: lido.membro };
  return { tipo: "conflito" };
}

/** Todos os membros marcados da organização, ativos ou não — quem consome decide pelo cálculo. */
export async function listarMarcados(
  db: Db,
  orgId: string,
): Promise<{ ok: true; membros: MembroParaPermissao[] } | { ok: false; mensagem: string }> {
  const { data, error } = await db
    .from("user_organizations")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .not("sdr_since", "is", null)
    .order("sdr_since", { ascending: true });
  if (error) return { ok: false, mensagem: error.message };
  return { ok: true, membros: (data ?? []) as MembroParaPermissao[] };
}

/**
 * A equipe inteira da organização, com o aceite do convite — o que a passagem
 * do SDR para o vendedor (`lib/sdr/passagem.ts`) precisa para decidir quem
 * passa e quem recebe. Sem nome nem e-mail: a tela já tem os nomes.
 */
export async function listarEquipeDaPassagem(
  db: Db,
  orgId: string,
): Promise<{ ok: true; membros: MembroDaPassagem[] } | { ok: false; mensagem: string }> {
  const { data, error } = await db
    .from("user_organizations")
    .select(`${COLUNAS}, accepted_at`)
    .eq("organization_id", orgId);
  if (error) return { ok: false, mensagem: error.message };
  return { ok: true, membros: (data ?? []) as MembroDaPassagem[] };
}
