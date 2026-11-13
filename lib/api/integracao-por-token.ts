/**
 * O que a resposta de uma rota chamada por TOKEN (`Bearer dsk_…`) deve a quem
 * integra — um servidor (ERP), sem tela e sem ninguém para ler um aviso.
 *
 * Duas coisas que o ramo da sessão não precisa e o do token precisa:
 *
 *  1. `falhaDoHandlerParaToken` — a recusa de negócio (4xx) chega inteira, com
 *     `details`; a falha interna (5xx) chega SEM o texto do banco. Os handlers
 *     montam `ApiError(500, …, error.message)` com a mensagem do Postgres, e
 *     devolvê-la a um cliente externo entrega nome de coluna e de constraint a
 *     quem não devia vê-los, sem ajudar ninguém. O texto vai para o log, com o
 *     `X-Request-Id` que a resposta leva.
 *
 *  2. `recusaDaEtapaParaToken` — o ERP guarda os ids das etapas (é o que a
 *     documentação manda). Etapa arquivada depois disso seguia aceitando card
 *     em silêncio; e card criado direto em etapa de ganho nascia ganho, sem
 *     motivo e sem passar pela régua do mover. A recusa diz o que fazer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiError } from "@/lib/api/types";
import { fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";

/** A resposta de erro de um handler, como o integrador deve receber. */
export function falhaDoHandlerParaToken(err: ApiError, requestId: string, rota: string): Response {
  if (err.status >= 500) {
    logger.error("api por token: falha interna", { rota, requestId, code: err.code, erro: err.message });
    return fail(
      "internal_error",
      "Erro interno ao processar o pedido. Tente de novo; se persistir, informe o X-Request-Id desta resposta a quem opera a instalação.",
      err.status,
      { requestId },
    );
  }
  return fail(err.code, err.message, err.status, {
    details: err.details as Record<string, unknown> | undefined,
    requestId,
  });
}

export type UsoDaEtapa = "criar" | "mover";

/**
 * Recusa (422) quando a etapa não serve ao pedido; `null` quando serve — ou
 * quando a etapa não existe nesta organização ou a leitura falhou: aí quem
 * responde é o handler, com o 404/500 de sempre.
 *
 * `organizationId` vem da linha do token, nunca do corpo; o client do token
 * ignora a RLS, então o filtro de organização é este.
 */
export async function recusaDaEtapaParaToken(
  supabase: SupabaseClient,
  opts: { organizationId: string; stageId: string; uso: UsoDaEtapa; requestId: string },
): Promise<Response | null> {
  const { organizationId, stageId, uso, requestId } = opts;
  const { data: etapa, error } = await supabase
    .from("crm_stages")
    .select("id, pipeline_id, is_won, is_lost, is_archived")
    .eq("organization_id", organizationId)
    .eq("id", stageId)
    .maybeSingle();
  if (error || !etapa) return null;

  const recusar = (motivo: string, mensagem: string) =>
    fail("validation_failed", mensagem, 422, { requestId, details: { campo: "stage_id", motivo } });

  if (etapa.is_archived) {
    return recusar(
      "etapa_arquivada",
      "Esta etapa foi arquivada. Leia as etapas do funil de novo (GET /api/v1/pipelines/{id}/stages) e use uma etapa ativa.",
    );
  }
  if (uso === "criar" && (etapa.is_won || etapa.is_lost)) {
    return recusar(
      "etapa_de_fechamento",
      "Card não nasce em etapa de ganho ou de perda. Crie numa etapa aberta e mude a etapa com POST /api/v1/leads/{id}/move.",
    );
  }

  const { data: funil } = await supabase
    .from("crm_pipelines")
    .select("id, is_archived")
    .eq("organization_id", organizationId)
    .eq("id", etapa.pipeline_id)
    .maybeSingle();
  if (funil?.is_archived) {
    return recusar(
      "funil_arquivado",
      "O funil desta etapa foi arquivado. Leia os funis de novo (GET /api/v1/pipelines) e use um funil ativo.",
    );
  }
  return null;
}
