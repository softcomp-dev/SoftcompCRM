// lib/propostas/status-do-item.ts
import { calcularTotal } from "./total";
import type { ProposalItemInput, ProposalStatus, StatusDoItemDaProposta } from "./tipos";

/**
 * A regra do status de cada item da proposta (migration 9261), num lugar só.
 *
 * O item vive duas fases, e a fase sai da PROPOSTA e do NEGÓCIO, nunca do item:
 *
 *   cotação — proposta `enviada`: o cliente responde item a item
 *             (pendente → aceito | recusado, e dá para voltar atrás);
 *   pedido  — proposta `aceita` E negócio marcado como pedido
 *             (`crm_leads.sales_document_kind = 'order'`): o item aceito anda
 *             para `em_producao` e `entregue`.
 *
 * Fora dessas duas fases (rascunho, vencida, cancelada, substituída, recusada,
 * ou aceita num negócio que ainda é cotação) nenhum status muda. O item
 * recusado não entra no pedido: o que o cliente não comprou não se produz.
 */

export type FaseDoItem = "cotacao" | "pedido";

export const STATUS_DA_COTACAO = ["pendente", "aceito", "recusado"] as const satisfies readonly StatusDoItemDaProposta[];
export const STATUS_DO_PEDIDO = ["aceito", "em_producao", "entregue"] as const satisfies readonly StatusDoItemDaProposta[];

/** O que conta como vendido: o aceito e tudo o que veio depois dele. */
export const STATUS_QUE_CONTAM_COMO_VENDA: readonly StatusDoItemDaProposta[] = ["aceito", "em_producao", "entregue"];

export const ROTULO_DO_STATUS_DO_ITEM: Record<StatusDoItemDaProposta, string> = {
  pendente: "Pendente",
  aceito: "Aceito",
  recusado: "Recusado",
  em_producao: "Em produção",
  entregue: "Entregue",
};

export function faseDoItem(
  statusDaProposta: ProposalStatus | string,
  tipoDoDocumentoDoNegocio: string | null | undefined,
): FaseDoItem | null {
  if (statusDaProposta === "enviada") return "cotacao";
  if (statusDaProposta === "aceita" && tipoDoDocumentoDoNegocio === "order") return "pedido";
  return null;
}

export function statusPermitidosNaFase(fase: FaseDoItem | null): readonly StatusDoItemDaProposta[] {
  if (fase === "cotacao") return STATUS_DA_COTACAO;
  if (fase === "pedido") return STATUS_DO_PEDIDO;
  return [];
}

/** O item pode ir de `de` para `para` nesta fase? Ficar onde está também vale (idempotente). */
export function podeMudarStatus(fase: FaseDoItem | null, de: StatusDoItemDaProposta, para: StatusDoItemDaProposta): boolean {
  const permitidos = statusPermitidosNaFase(fase);
  return permitidos.includes(de) && permitidos.includes(para);
}

/**
 * O desfecho que os itens dão à proposta na cotação:
 * - algum pendente (ou nenhum item): ainda não há desfecho;
 * - todos recusados: `recusada`;
 * - senão (pelo menos um aceito): `aceita` — aceite parcial é aceite.
 */
export function desfechoDosItens(statuses: readonly StatusDoItemDaProposta[]): "aceita" | "recusada" | null {
  if (statuses.length === 0) return null;
  if (statuses.some((s) => s === "pendente")) return null;
  return statuses.every((s) => s === "recusado") ? "recusada" : "aceita";
}

export type ItemComValor = Pick<ProposalItemInput, "quantidade" | "preco_unitario_cents" | "desconto_cents"> & {
  status: StatusDoItemDaProposta;
};

/** Soma dos itens vendidos, com a MESMA conta do total da proposta (`calcularTotal`). */
export function valorVendidoCents(itens: readonly ItemComValor[]): number {
  return calcularTotal(itens.filter((it) => STATUS_QUE_CONTAM_COMO_VENDA.includes(it.status)));
}
