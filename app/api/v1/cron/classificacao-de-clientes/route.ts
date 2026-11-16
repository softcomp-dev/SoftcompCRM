/**
 * O CLIENTE QUE ESFRIOU — aviso na Central quando ele vira pré-inativo.
 *
 * Uma vez por dia, para cada organização ativa: os contatos cuja última venda
 * ganha (`contacts.last_won_at`, migration 9257) acabou de passar do prazo de
 * ativo da organização ganham UM aviso `client_pre_inactive` apontando para a
 * ficha. A régua de quem entra está em `lib/clientes/aviso-de-pre-inativo.ts`
 * (janela de poucos dias, para não haver rajada; e a marca
 * `pre_inativo_avisado_para`, para não repetir o aviso da mesma venda).
 *
 * O texto do aviso NÃO leva o nome do cliente: o item da Central não entra na
 * cascata de anonimização da LGPD, e o `ref` já leva à ficha.
 *
 * Rodada sem efeito não audita (`cron-audita-so-quando-ha-efeito.test.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { janelaDoAviso, precisaAvisar } from "@/lib/clientes/aviso-de-pre-inativo";
import { limitesDaOrganizacao } from "@/lib/clientes/classificacao";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { ehOperante, STATUS_OPERANTE } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

/** Teto por organização e rodada: o que sobrar fica para amanhã, dentro da janela. */
const LIMITE_POR_ORGANIZACAO = 200;

interface Organizacao {
  id: string;
  locale: string | null;
  timezone: string | null;
  status: string | null;
  classificacao_ativo_dias: number | null;
  classificacao_pre_inativo_dias: number | null;
}

interface Candidato {
  id: string;
  last_won_at: string | null;
  pre_inativo_avisado_para: string | null;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  const { data: orgs, error: erroOrgs } = await admin
    .from("organizations")
    .select("id, status, locale, timezone, classificacao_ativo_dias, classificacao_pre_inativo_dias")
    // Organização parada (suspensa, arquivada) não recebe aviso: a régua é
    // `lib/organizacao/operante`, e o `ehOperante` no laço é cinto.
    .eq("status", STATUS_OPERANTE);
  if (erroOrgs) {
    logger.error("[classificacao-de-clientes] organizações não lidas", { error: erroOrgs.message, requestId });
    return fail("internal_error", "Falha ao ler as organizações.", 500, { requestId });
  }

  let examinados = 0;
  let avisados = 0;
  let marcados = 0;

  for (const org of (orgs ?? []) as Organizacao[]) {
    if (!ehOperante(org.status)) continue;
    const limites = limitesDaOrganizacao(org);
    const { de, ate } = janelaDoAviso(limites, agora);
    const idioma = normalizarIdioma(org.locale);
    const t = (texto: string) => traduzir(texto, idioma);

    const { data, error } = await admin
      .from("contacts")
      .select("id, last_won_at, pre_inativo_avisado_para")
      .eq("organization_id", org.id)
      .eq("kind", "person")
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .eq("is_personal", false)
      // `neq` sozinho descartaria `contact_type` nulo (null <> x é null).
      .or("contact_type.is.null,contact_type.neq.fornecedor")
      .gte("last_won_at", de)
      .lt("last_won_at", ate)
      .order("last_won_at", { ascending: true })
      .limit(LIMITE_POR_ORGANIZACAO);
    if (error) {
      logger.error("[classificacao-de-clientes] contatos não lidos", {
        organization_id: org.id,
        error: error.message,
        requestId,
      });
      continue;
    }

    const candidatos = ((data ?? []) as Candidato[]).filter(precisaAvisar);
    examinados += (data ?? []).length;

    for (const c of candidatos) {
      // Um aviso ABERTO por contato: se a equipe ainda não resolveu o anterior,
      // só a marca anda (é a mesma situação, com outra data de venda).
      const { data: jaTem } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", org.id)
        .eq("kind", "client_pre_inactive")
        .eq("ref_id", c.id)
        .eq("status", "open")
        .maybeSingle();

      if (!jaTem) {
        // No fuso da ORGANIZAÇÃO: o servidor roda em UTC, e uma venda fechada
        // às 22h de Brasília apareceria como do dia seguinte.
        const ultima = new Date(c.last_won_at as string).toLocaleDateString(idioma, {
          timeZone: org.timezone ?? "America/Sao_Paulo",
        });
        const { error: erroAviso } = await admin.from("agent_inbox_items").insert({
          organization_id: org.id,
          kind: "client_pre_inactive",
          // `warn`: há venda a recuperar, mas nada quebrou.
          severity: "warn",
          title: t("Um cliente está esfriando — virou pré-inativo"),
          body: t(
            "A última venda ganha deste cliente foi em {data}, e o prazo de ativo da empresa é de {ativo} dias. Se não houver nova venda, ele vira inativo depois de {pre} dias.",
          )
            .replace("{data}", ultima)
            .replace("{ativo}", String(limites.ativoDias))
            .replace("{pre}", String(limites.preInativoDias)),
          ref_kind: "contact",
          ref_id: c.id,
        });
        if (erroAviso) {
          logger.error("[classificacao-de-clientes] aviso não foi aberto", {
            organization_id: org.id,
            contact_id: c.id,
            error: erroAviso.message,
            requestId,
          });
          continue;
        }
        avisados += 1;
      }

      const { error: erroMarca } = await admin
        .from("contacts")
        .update({ pre_inativo_avisado_para: c.last_won_at })
        .eq("id", c.id)
        .eq("organization_id", org.id);
      if (erroMarca) {
        logger.error("[classificacao-de-clientes] marca do aviso não gravada", {
          contact_id: c.id,
          error: erroMarca.message,
          requestId,
        });
        continue;
      }
      marcados += 1;
    }
  }

  if (avisados > 0 || marcados > 0) {
    await audit({
      action: "cron.classificacao_de_clientes",
      resourceType: "contact",
      requestId,
      metadata: { avisados, marcados, examinados },
    });
  }

  return ok({ organizacoes: (orgs ?? []).length, examinados, avisados, marcados }, { requestId });
}

export const GET = handle;
export const POST = handle;
