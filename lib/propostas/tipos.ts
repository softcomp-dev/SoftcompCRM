export type ProposalStatus =
  | "rascunho" | "enviando" | "enviada" | "aceita" | "recusada" | "vencida" | "cancelada" | "substituida";

export interface ProposalItemInput {
  id?: string;
  product_id: string | null;
  descricao: string;
  quantidade: number;
  /** null = "a definir" (§5.2) — só permitido quando product_id também é null. */
  preco_unitario_cents: number | null;
  desconto_cents: number;
  position: number;
}

export interface ProposalRow {
  id: string;
  organization_id: string;
  // D10: sobrevive ao negócio apagado — o FK virou `on delete set null`.
  lead_id: string | null;
  contact_id: string | null;
  status: ProposalStatus;
  numero: number | null;
  ano: number | null;
  versao: number;
  substitui_id: string | null;
  revision: number;
  total_cents: number;
  // D3: o desfecho do envio.
  message_id: string | null;
  ultima_falha_envio: string | null;
  // D10: o nome impresso no PDF, para o documento continuar legível órfão.
  destinatario_nome: string | null;
}

/**
 * Status do item da proposta (migration 9261) — o MESMO vocabulário do CHECK
 * `crm_proposal_items_status_conhecido` (vigiado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`).
 *
 * Os três primeiros são da COTAÇÃO; `em_producao` e `entregue` só existem
 * depois que a cotação aceita vira PEDIDO. Quem decide a fase é
 * `lib/propostas/status-do-item.ts`.
 */
export const STATUS_DO_ITEM_DA_PROPOSTA = ["pendente", "aceito", "recusado", "em_producao", "entregue"] as const;
export type StatusDoItemDaProposta = (typeof STATUS_DO_ITEM_DA_PROPOSTA)[number];
