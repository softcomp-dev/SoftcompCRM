// lib/propostas/itens-da-decisao.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";

import { valorVendidoCents, type ItemComValor } from "./status-do-item";
import type { StatusDoItemDaProposta } from "./tipos";

/**
 * O que a decisão da proposta faz nos ITENS e no VALOR do negócio
 * (migration 9261).
 *
 * Recebe o cliente de serviço (`admin`): a policy de escrita de
 * `crm_proposal_items` só aceita proposta em rascunho — é ela que congela o
 * conteúdo enviado ao cliente —, então a escrita de status passa por aqui,
 * sempre filtrando a organização resolvida da sessão e tocando só as colunas
 * de status.
 */

/**
 * Decisão da proposta INTEIRA: o que ainda estava pendente segue a decisão.
 * O item que a pessoa já tinha decidido um a um fica como está — a decisão
 * inteira não desfaz uma recusa explícita.
 */
export async function fecharItensPendentes(
  admin: SupabaseClient,
  organizationId: string,
  propostaId: string,
  decisao: "aceita" | "recusada",
): Promise<void> {
  const status: StatusDoItemDaProposta = decisao === "aceita" ? "aceito" : "recusado";
  const { error } = await admin
    .from("crm_proposal_items")
    .update({ status, status_changed_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("proposal_id", propostaId)
    .eq("status", "pendente");
  if (error) {
    logger.error("proposal.items: falha ao fechar os itens pendentes depois da decisão", {
      propostaId,
      organizationId,
      erro: error.message,
    });
  }
}

export interface SincronizarValorInput {
  organizationId: string;
  propostaId: string;
  leadId: string | null;
  contactId: string | null;
  userId: string;
}

/**
 * Proposta aceita: o valor do negócio passa a ser a soma do que foi VENDIDO
 * (aceito, em produção, entregue) — aceite parcial não deixa o negócio com o
 * total cheio de um pedido que não aconteceu. O total original continua na
 * proposta. Só grava (e só registra atividade) quando o valor muda.
 *
 * Best-effort: a decisão já foi gravada; falha aqui vira log, nunca 500.
 */
export async function sincronizarValorVendido(admin: SupabaseClient, input: SincronizarValorInput): Promise<void> {
  const { organizationId, propostaId, leadId, contactId, userId } = input;
  if (!leadId) return;
  try {
    const { data: itens, error: itensErr } = await admin
      .from("crm_proposal_items")
      .select("status, quantidade, preco_unitario_cents, desconto_cents")
      .eq("organization_id", organizationId)
      .eq("proposal_id", propostaId);
    if (itensErr) throw new Error(itensErr.message);
    const valor = valorVendidoCents((itens ?? []) as ItemComValor[]);

    const { data: lead, error: leadErr } = await admin
      .from("crm_leads")
      .select("value_cents")
      .eq("organization_id", organizationId)
      .eq("id", leadId)
      .maybeSingle();
    if (leadErr) throw new Error(leadErr.message);
    if (!lead) return;
    const antes = (lead as { value_cents: number | null }).value_cents;
    if (antes === valor) return;

    const { error: updErr } = await admin
      .from("crm_leads")
      .update({ value_cents: valor })
      .eq("organization_id", organizationId)
      .eq("id", leadId);
    if (updErr) throw new Error(updErr.message);

    await emitLeadActivity(admin, {
      organizationId,
      leadId,
      contactId,
      type: "proposal_value_changed",
      sourceModule: "proposals",
      sourceId: propostaId,
      actor: { type: "user", id: userId },
      reason: `Valor do negócio atualizado de ${antes ?? "—"} para ${valor} centavos (itens aceitos da proposta)`,
    });
  } catch (erro) {
    logger.error("proposal.items: falha ao atualizar o valor do negócio pelos itens aceitos", {
      propostaId,
      organizationId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
