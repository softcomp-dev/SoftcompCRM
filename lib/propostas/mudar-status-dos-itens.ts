// lib/propostas/mudar-status-dos-itens.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

import { aplicarEfeitosDaDecisao } from "./efeitos-da-decisao";
import { sincronizarValorVendido } from "./itens-da-decisao";
import {
  ROTULO_DO_STATUS_DO_ITEM,
  desfechoDosItens,
  faseDoItem,
  podeMudarStatus,
  type FaseDoItem,
} from "./status-do-item";
import type { StatusDoItemDaProposta } from "./tipos";

/**
 * A mudança de status dos itens da proposta (migration 9261), num lugar só.
 *
 * Três portas chamam esta função e nenhuma repete a regra: a tela
 * (`PATCH /api/v1/proposals/[id]/itens` por sessão), a integração
 * (o mesmo PATCH por `Bearer dsk_…`) e o agente/cliente MCP
 * (`crm_update_proposal_items_status`).
 *
 *   cotação (proposta `enviada`): pendente | aceito | recusado. Quando nenhum
 *     item fica pendente, a proposta se resolve — `aceita` se algum item foi
 *     aceito, `recusada` se todos foram recusados — com o mesmo rastro da
 *     decisão inteira, e o valor do negócio passa a ser a soma dos aceitos.
 *   pedido (proposta `aceita` e negócio com `sales_document_kind = 'order'`):
 *     aceito | em_producao | entregue. A proposta não muda.
 *
 * `db` é o cliente de SERVIÇO: a policy de escrita de `crm_proposal_items` só
 * aceita rascunho (é ela que congela o conteúdo enviado), então toda consulta
 * aqui filtra `organization_id` — que vem da sessão, do token ou do contexto
 * do MCP, nunca do corpo — e só as colunas de status são escritas.
 *
 * As mensagens são em português; a rota da tela as traduz para quem lê.
 */

export interface ItemPedido {
  id: string;
  status: StatusDoItemDaProposta;
}

export interface MudarStatusDosItensInput {
  db: SupabaseClient;
  organizationId: string;
  actor: Actor;
  /** Linha de `api_tokens` quando a chamada veio por token (auditoria). */
  apiTokenId?: string | null;
  requestId: string;
  propostaId: string;
  itens: readonly ItemPedido[];
  /** Por onde entrou: vai para o metadata da auditoria. */
  via: "tela" | "token" | "mcp";
}

export interface ResultadoDosItens {
  id: string;
  /** Status da PROPOSTA depois da mudança. */
  status: string;
  fase: FaseDoItem | null;
  itens: Array<{ id: string; status: StatusDoItemDaProposta }>;
}

export type MudarStatusDosItensSaida =
  | { ok: true; resultado: ResultadoDosItens }
  | {
      ok: false;
      httpStatus: 404 | 409 | 422 | 500;
      code: "not_found" | "proposal_context_stale" | "validation_failed" | "internal_error";
      message: string;
      details?: Record<string, unknown>;
    };

interface ItemDaProposta {
  id: string;
  descricao: string;
  status: StatusDoItemDaProposta;
}

function recusa(
  httpStatus: 404 | 409 | 422 | 500,
  code: "not_found" | "proposal_context_stale" | "validation_failed" | "internal_error",
  message: string,
  details?: Record<string, unknown>,
): MudarStatusDosItensSaida {
  return { ok: false, httpStatus, code, message, ...(details ? { details } : {}) };
}

export async function mudarStatusDosItens(input: MudarStatusDosItensInput): Promise<MudarStatusDosItensSaida> {
  const { db, organizationId: orgId, actor, apiTokenId, requestId, propostaId: id, via } = input;
  // O último pedido para o mesmo item vale (o mesmo que um PATCH repetido faria).
  const pedidos = new Map(input.itens.map((it) => [it.id, it.status]));

  const { data: proposta } = await db
    .from("crm_proposals")
    .select("id, status, lead_id, contact_id, retorno_id")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!proposta) return recusa(404, "not_found", "Proposta não encontrada.");

  let tipoDoDocumento: string | null = null;
  if (proposta.lead_id) {
    const { data: lead } = await db
      .from("crm_leads")
      .select("sales_document_kind")
      .eq("organization_id", orgId)
      .eq("id", proposta.lead_id)
      .maybeSingle();
    tipoDoDocumento = (lead as { sales_document_kind: string | null } | null)?.sales_document_kind ?? null;
  }

  const fase = faseDoItem(proposta.status, tipoDoDocumento);
  if (!fase) {
    return recusa(
      409,
      "proposal_context_stale",
      "O status dos itens só muda com a proposta enviada, ou aceita num negócio marcado como pedido.",
    );
  }

  const { data: itensAtuais, error: itensErr } = await db
    .from("crm_proposal_items")
    .select("id, descricao, status")
    .eq("organization_id", orgId)
    .eq("proposal_id", id);
  if (itensErr) return recusa(500, "internal_error", "Falha ao carregar os itens.");
  const porId = new Map(((itensAtuais ?? []) as ItemDaProposta[]).map((it) => [it.id, it]));

  const foraDaProposta = [...pedidos.keys()].filter((itemId) => !porId.has(itemId));
  if (foraDaProposta.length > 0) {
    return recusa(422, "validation_failed", "Há itens que não são desta proposta.", { itens: foraDaProposta });
  }
  const recusados = [...pedidos].filter(([itemId, para]) => !podeMudarStatus(fase, porId.get(itemId)!.status, para));
  if (recusados.length > 0) {
    return recusa(
      422,
      "validation_failed",
      fase === "cotacao"
        ? "Na cotação o item só pode ficar pendente, aceito ou recusado."
        : "No pedido só o item aceito avança para em produção e entregue.",
      { itens: recusados.map(([itemId]) => itemId) },
    );
  }

  const agora = new Date().toISOString();
  const mudancas: Array<{ item: ItemDaProposta; para: StatusDoItemDaProposta }> = [];
  for (const [itemId, para] of pedidos) {
    const item = porId.get(itemId)!;
    if (item.status === para) continue;
    // `eq("status", de)`: se outra pessoa mudou o item entre a leitura e a
    // escrita, esta não sobrescreve — devolve 409 e quem chamou recarrega.
    const { data: gravado, error } = await db
      .from("crm_proposal_items")
      .update({ status: para, status_changed_at: agora })
      .eq("organization_id", orgId)
      .eq("proposal_id", id)
      .eq("id", itemId)
      .eq("status", item.status)
      .select("id")
      .maybeSingle();
    if (error) return recusa(500, "internal_error", "Falha ao gravar o status do item.");
    if (!gravado) {
      return recusa(409, "proposal_context_stale", "Um item mudou enquanto você editava. Recarregue e tente de novo.");
    }
    mudancas.push({ item, para });
    item.status = para;
  }

  if (mudancas.length > 0) {
    if (proposta.lead_id) {
      await emitLeadActivity(db, {
        organizationId: orgId,
        leadId: proposta.lead_id,
        contactId: proposta.contact_id,
        type: "proposal_item_status_changed",
        sourceModule: "proposals",
        sourceId: id,
        actor,
        reason: mudancas.map(({ item, para }) => `${item.descricao}: ${ROTULO_DO_STATUS_DO_ITEM[para]}`).join("; "),
      });
    }
    void audit({
      action: "proposal.item_status_changed",
      actorUserId: actor.type === "user" ? actor.id : null,
      actorApiTokenId: apiTokenId ?? null,
      organizationId: orgId,
      resourceType: "crm_proposals",
      resourceId: id,
      requestId,
      metadata: {
        via,
        ...(actor.type === "user" ? {} : { actor_type: actor.type, actor_id: actor.id }),
        itens: mudancas.map(({ item, para }) => ({ id: item.id, para })),
      },
    });
  }

  // Na cotação, o último item decidido resolve a proposta.
  let statusDaProposta: string = proposta.status;
  const desfecho = fase === "cotacao" ? desfechoDosItens([...porId.values()].map((it) => it.status)) : null;
  if (desfecho) {
    const { data: decidida } = await db
      .from("crm_proposals")
      .update({
        status: desfecho,
        decided_at: agora,
        // FK para auth.users: só pessoa entra aqui; token e agente ficam na auditoria.
        decided_by_user_id: actor.type === "user" ? actor.id : null,
      })
      .eq("organization_id", orgId)
      .eq("id", id)
      .eq("status", "enviada")
      .select("id, lead_id, contact_id, retorno_id")
      .maybeSingle();
    if (decidida) {
      statusDaProposta = desfecho;
      await aplicarEfeitosDaDecisao({
        db,
        organizationId: orgId,
        actor,
        apiTokenId,
        requestId,
        proposta: decidida as { id: string; lead_id: string | null; contact_id: string | null; retorno_id: string | null },
        decisao: desfecho,
      });
      // Aceite (inteiro ou parcial): o negócio passa a valer o que foi vendido.
      // Recusa não mexe no valor (spec §16.2). No pedido o valor não muda:
      // aceito, em produção e entregue contam igual.
      if (desfecho === "aceita") {
        await sincronizarValorVendido(db, {
          organizationId: orgId,
          propostaId: id,
          leadId: proposta.lead_id,
          contactId: proposta.contact_id,
          actor,
        });
      }
    }
  }

  return {
    ok: true,
    resultado: {
      id,
      status: statusDaProposta,
      fase: statusDaProposta === proposta.status ? fase : faseDoItem(statusDaProposta, tipoDoDocumento),
      itens: [...porId.values()].map((it) => ({ id: it.id, status: it.status })),
    },
  };
}
