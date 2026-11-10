/**
 * Quem recebe os leads novos na distribuição automática: a equipe inteira ou
 * só os SDRs ativos — os DOIS fluxos de trabalho, decididos por empresa.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 *   função SDR desligada                     → fluxo "equipe" (o de sempre)
 *   ligada, mas NENHUM SDR ativo             → fluxo "equipe"
 *   ligada e ao menos um SDR ativo           → fluxo "sdr": só eles recebem
 *
 * O segundo caso é de propósito. Ligar a função antes de marcar alguém não pode
 * parar a entrada de leads da empresa — e "ninguém marcado" (ou todos sem
 * efeito) é configuração incompleta, não decisão de esperar. Já "há SDR, mas
 * todos ocupados ou fora do horário" é decisão: aí o lead ESPERA um SDR na fila
 * (o worker reenfileira e avisa como sempre), e não vaza para o resto da equipe.
 *
 * "Ativo" é a regra de `permissoes.ts` (função ligada + vínculo ativo + papel
 * agent ou acima + marcado); disponibilidade, jornada e folga continuam sendo
 * do rodízio (`lib/routing/eligibles.ts`), que aplica este conjunto por cima.
 *
 * Só a distribuição de CONVERSA NOVA usa isto (`lib/routing/worker.ts`). A
 * passagem da IA para um humano (`lib/mcp/tools/handoff.ts`) e o resumo da
 * fila seguem com a equipe inteira: pedir uma pessoa no meio de um atendimento
 * não é lead novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerConfiguracaoSdr } from "./configuracao";
import { motivoSdrInativo, type MembroParaPermissao } from "./permissoes";

export type FluxoDeDistribuicao =
  | { fluxo: "equipe"; motivo: "funcao_desligada" | "nenhum_sdr_ativo" }
  | { fluxo: "sdr"; userIds: ReadonlySet<string> };

/** Puro: decide o fluxo a partir do interruptor e dos membros marcados. */
export function fluxoDeDistribuicao(
  funcaoLigada: boolean,
  marcados: readonly MembroParaPermissao[],
): FluxoDeDistribuicao {
  if (!funcaoLigada) return { fluxo: "equipe", motivo: "funcao_desligada" };
  const ativos = marcados.filter((m) => motivoSdrInativo(m, true) === null).map((m) => m.user_id);
  if (ativos.length === 0) return { fluxo: "equipe", motivo: "nenhum_sdr_ativo" };
  return { fluxo: "sdr", userIds: new Set(ativos) };
}

/**
 * Lê o interruptor e os marcados da organização e devolve o fluxo. Erro de
 * banco LANÇA (o worker reenfileira o evento): cair no fluxo "equipe" por falha
 * de leitura entregaria a outra pessoa o lead que era de um SDR.
 */
export async function carregarFluxoDeDistribuicao(
  db: Pick<SupabaseClient, "from">,
  orgId: string,
  settings: unknown,
): Promise<FluxoDeDistribuicao> {
  const { enabled } = lerConfiguracaoSdr(settings);
  if (!enabled) return { fluxo: "equipe", motivo: "funcao_desligada" };
  const { data, error } = await db
    .from("user_organizations")
    .select("user_id, role, revoked_at, sdr_since")
    .eq("organization_id", orgId)
    .not("sdr_since", "is", null);
  if (error) throw new Error(error.message);
  return fluxoDeDistribuicao(true, (data ?? []) as MembroParaPermissao[]);
}
