import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { LIMITES_PADRAO, limitesDaOrganizacao, type LimitesDeClassificacao } from "./classificacao";

type LinhaDePrazos = { classificacao_ativo_dias?: number | null; classificacao_pre_inativo_dias?: number | null };

/**
 * Os prazos de classificação da organização, lidos de `organizations`.
 *
 * NUNCA lança: a classificação é selo e filtro, e uma leitura que falhou não
 * pode derrubar a lista de contatos. Cai no padrão (90/180) e registra.
 * O `organizationId` vem do contexto resolvido no servidor, nunca do corpo.
 */
export async function limitesDaOrganizacaoNoBanco(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<LimitesDeClassificacao> {
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("classificacao_ativo_dias, classificacao_pre_inativo_dias")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) {
      logger.warn("classificacao.limites_indisponiveis", { organizationId, error: error.message });
      return LIMITES_PADRAO;
    }
    return limitesDaOrganizacao(data as LinhaDePrazos | null);
  } catch (err) {
    logger.warn("classificacao.limites_indisponiveis", {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return LIMITES_PADRAO;
  }
}
