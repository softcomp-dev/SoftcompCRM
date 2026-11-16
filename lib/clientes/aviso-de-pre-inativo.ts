/**
 * QUEM A CENTRAL AVISA QUE VIROU PRÉ-INATIVO (migration 9257).
 *
 * O cron `classificacao-de-clientes` roda uma vez por dia e abre UM aviso por
 * venda: quando o cliente passa do prazo de ativo, a equipe é chamada a agir
 * antes de ele virar inativo.
 *
 * Duas regras, e as duas moram aqui para serem testadas sem banco:
 *
 *   1. A JANELA: só conta quem cruzou o prazo de ativo nos últimos
 *      `JANELA_DO_AVISO_DIAS` dias. A janela cobre rodadas perdidas (servidor
 *      desligado no fim de semana) e impede a RAJADA: sem ela, a primeira
 *      rodada depois da atualização avisaria de uma vez todo cliente que já
 *      estava pré-inativo — centenas de itens que enterram a Central.
 *   2. A MARCA: `contacts.pre_inativo_avisado_para` guarda o `last_won_at` já
 *      avisado. Igual ao atual, já foi; diferente (ou nula), o cliente comprou
 *      de novo depois do último aviso e voltou a esfriar.
 */
import type { LimitesDeClassificacao } from "./classificacao";

export const JANELA_DO_AVISO_DIAS = 7;

const DIA_MS = 86_400_000;

/**
 * O intervalo de `last_won_at` de quem virou pré-inativo dentro da janela:
 * `de <= last_won_at < ate`. O `de` nunca recua além do prazo de pré-inativo —
 * quem já é inativo não recebe aviso de pré-inativo.
 */
export function janelaDoAviso(
  limites: LimitesDeClassificacao,
  agora: Date = new Date(),
): { de: string; ate: string } {
  const t = agora.getTime();
  const ate = t - limites.ativoDias * DIA_MS;
  const deJanela = t - (limites.ativoDias + JANELA_DO_AVISO_DIAS) * DIA_MS;
  const dePreInativo = t - limites.preInativoDias * DIA_MS;
  return { de: new Date(Math.max(deJanela, dePreInativo)).toISOString(), ate: new Date(ate).toISOString() };
}

export function precisaAvisar(contato: {
  last_won_at: string | null;
  pre_inativo_avisado_para: string | null;
}): boolean {
  if (!contato.last_won_at) return false;
  if (!contato.pre_inativo_avisado_para) return true;
  return Date.parse(contato.pre_inativo_avisado_para) !== Date.parse(contato.last_won_at);
}
