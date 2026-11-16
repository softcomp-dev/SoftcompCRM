/**
 * A COR DO DESFECHO NO CARD — ganho, perdido ou ganho parcial.
 *
 * Negócio fechado tem uma cor só, a do desfecho: faixa lateral e fundo leve.
 * Ela SUBSTITUI a borda de estado (`resolveCardState`): "aguardando você" e
 * "esfriando" são sinais de negócio aberto, e somar as duas cores seria o
 * card com dois estados que a Lei C (um accent por vez) proíbe.
 *
 * O parcial é um ganho (`status = 'won'`, migration 9259) com a marca
 * `is_partial_win` — a marca decide a cor, o status decide que fechou.
 */
import type { Lead } from "@/lib/types/leads";

export type DesfechoDoCard = "ganho" | "perdido" | "parcial";

export function desfechoDoCard(
  lead: Pick<Lead, "status"> & { is_partial_win?: boolean | null },
): DesfechoDoCard | null {
  if (lead.status === "won") return lead.is_partial_win ? "parcial" : "ganho";
  if (lead.status === "lost") return "perdido";
  return null;
}

/** As classes de cada desfecho: faixa (2px à esquerda) e fundo do card. */
export const CORES_DO_DESFECHO: Record<DesfechoDoCard, { faixa: string; fundo: string }> = {
  ganho: { faixa: "bg-success", fundo: "bg-success-bg" },
  perdido: { faixa: "bg-error", fundo: "bg-error-bg" },
  parcial: { faixa: "bg-warning", fundo: "bg-warning-bg" },
};

/** O nome do desfecho para leitor de tela e para o selo do dossiê. */
export function rotuloDoDesfecho(desfecho: DesfechoDoCard, t: (texto: string) => string): string {
  if (desfecho === "ganho") return t("Ganho");
  if (desfecho === "perdido") return t("Perdido");
  return t("Ganho parcial");
}
