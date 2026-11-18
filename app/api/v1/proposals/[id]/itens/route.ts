/**
 * PATCH /api/v1/proposals/[id]/itens — muda o status de um ou mais itens da
 * proposta (migration 9261).
 *
 *   cotação (proposta `enviada`): pendente | aceito | recusado. Quando nenhum
 *     item fica pendente, a proposta se resolve sozinha — `aceita` se algum
 *     item foi aceito, `recusada` se todos foram recusados — com o mesmo
 *     rastro da decisão inteira (`/decide`), e o valor do negócio passa a ser
 *     a soma dos itens aceitos.
 *   pedido (proposta `aceita` e negócio com `sales_document_kind = 'order'`):
 *     aceito | em_producao | entregue. A proposta não muda.
 *
 * Só as colunas de status são escritas: descrição, quantidade e preço do item
 * enviado continuam congelados. A regra das fases é `lib/propostas/status-do-item.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { aplicarEfeitosDaDecisao } from "@/lib/propostas/efeitos-da-decisao";
import { sincronizarValorVendido } from "@/lib/propostas/itens-da-decisao";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import {
  ROTULO_DO_STATUS_DO_ITEM,
  desfechoDosItens,
  faseDoItem,
  podeMudarStatus,
} from "@/lib/propostas/status-do-item";
import { STATUS_DO_ITEM_DA_PROPOSTA, type StatusDoItemDaProposta } from "@/lib/propostas/tipos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  itens: z
    .array(z.object({ id: z.string().uuid(), status: z.enum(STATUS_DO_ITEM_DA_PROPOSTA) }))
    .min(1)
    .max(200),
});
type Ctx = { params: Promise<{ id: string }> };

interface ItemDaProposta {
  id: string;
  descricao: string;
  status: StatusDoItemDaProposta;
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Mesmo papel de quem decide a proposta inteira (`/decide`).
  const authz = await requireRole("agent", { requestId, resource: "crm_proposals" });
  if (!authz.ok) return authz.response;
  const desligada = await sePropostasDesligadas(authz.org.orgId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  const orgId = authz.org.orgId;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  const pedidos = new Map(parsed.data.itens.map((it) => [it.id, it.status]));

  const admin = createAdminClient();
  const { data: proposta } = await admin
    .from("crm_proposals")
    .select("id, status, lead_id, contact_id, retorno_id")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });

  let tipoDoDocumento: string | null = null;
  if (proposta.lead_id) {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("sales_document_kind")
      .eq("organization_id", orgId)
      .eq("id", proposta.lead_id)
      .maybeSingle();
    tipoDoDocumento = (lead as { sales_document_kind: string | null } | null)?.sales_document_kind ?? null;
  }

  const fase = faseDoItem(proposta.status, tipoDoDocumento);
  if (!fase) {
    return fail(
      "proposal_context_stale",
      t("O status dos itens só muda com a proposta enviada, ou aceita num negócio marcado como pedido."),
      409,
      { requestId },
    );
  }

  const { data: itensAtuais, error: itensErr } = await admin
    .from("crm_proposal_items")
    .select("id, descricao, status")
    .eq("organization_id", orgId)
    .eq("proposal_id", id);
  if (itensErr) return fail("internal_error", t("Falha ao carregar os itens."), 500, { requestId });
  const porId = new Map(((itensAtuais ?? []) as ItemDaProposta[]).map((it) => [it.id, it]));

  const foraDaProposta = [...pedidos.keys()].filter((itemId) => !porId.has(itemId));
  if (foraDaProposta.length > 0) {
    return fail("validation_failed", t("Há itens que não são desta proposta."), 422, {
      requestId,
      details: { itens: foraDaProposta },
    });
  }
  const recusados = [...pedidos].filter(([itemId, para]) => !podeMudarStatus(fase, porId.get(itemId)!.status, para));
  if (recusados.length > 0) {
    return fail(
      "validation_failed",
      fase === "cotacao"
        ? t("Na cotação o item só pode ficar pendente, aceito ou recusado.")
        : t("No pedido só o item aceito avança para em produção e entregue."),
      422,
      { requestId, details: { itens: recusados.map(([itemId]) => itemId) } },
    );
  }

  const agora = new Date().toISOString();
  const mudancas: Array<{ item: ItemDaProposta; para: StatusDoItemDaProposta }> = [];
  for (const [itemId, para] of pedidos) {
    const item = porId.get(itemId)!;
    if (item.status === para) continue;
    // `eq("status", de)`: se outra pessoa mudou o item entre a leitura e a
    // escrita, esta não sobrescreve — devolve 409 e a tela recarrega.
    const { data: gravado, error } = await admin
      .from("crm_proposal_items")
      .update({ status: para, status_changed_at: agora })
      .eq("organization_id", orgId)
      .eq("proposal_id", id)
      .eq("id", itemId)
      .eq("status", item.status)
      .select("id")
      .maybeSingle();
    if (error) return fail("internal_error", t("Falha ao gravar o status do item."), 500, { requestId });
    if (!gravado) {
      return fail("proposal_context_stale", t("Um item mudou enquanto você editava. Recarregue e tente de novo."), 409, {
        requestId,
      });
    }
    mudancas.push({ item, para });
    item.status = para;
  }

  if (mudancas.length > 0) {
    if (proposta.lead_id) {
      await emitLeadActivity(admin, {
        organizationId: orgId,
        leadId: proposta.lead_id,
        contactId: proposta.contact_id,
        type: "proposal_item_status_changed",
        sourceModule: "proposals",
        sourceId: id,
        actor: { type: "user", id: authz.user.id },
        reason: mudancas
          .map(({ item, para }) => `${item.descricao}: ${ROTULO_DO_STATUS_DO_ITEM[para]}`)
          .join("; "),
      });
    }
    void audit({
      action: "proposal.item_status_changed",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_proposals",
      resourceId: id,
      requestId,
      metadata: { itens: mudancas.map(({ item, para }) => ({ id: item.id, para })) },
    });
  }

  // Na cotação, o último item decidido resolve a proposta.
  let statusDaProposta: string = proposta.status;
  const desfecho = fase === "cotacao" ? desfechoDosItens([...porId.values()].map((it) => it.status)) : null;
  if (desfecho) {
    const { data: decidida } = await admin
      .from("crm_proposals")
      .update({ status: desfecho, decided_at: agora, decided_by_user_id: authz.user.id })
      .eq("organization_id", orgId)
      .eq("id", id)
      .eq("status", "enviada")
      .select("id, lead_id, contact_id, retorno_id")
      .maybeSingle();
    if (decidida) {
      statusDaProposta = desfecho;
      await aplicarEfeitosDaDecisao({
        db: admin,
        organizationId: orgId,
        userId: authz.user.id,
        requestId,
        proposta: decidida as { id: string; lead_id: string | null; contact_id: string | null; retorno_id: string | null },
        decisao: desfecho,
      });
      // Aceite (inteiro ou parcial): o negócio passa a valer o que foi vendido.
      // Recusa não mexe no valor (spec §16.2). No pedido o valor não muda:
      // aceito, em produção e entregue contam igual.
      if (desfecho === "aceita") {
        await sincronizarValorVendido(admin, {
          organizationId: orgId,
          propostaId: id,
          leadId: proposta.lead_id,
          contactId: proposta.contact_id,
          userId: authz.user.id,
        });
      }
    }
  }

  return ok(
    {
      id,
      status: statusDaProposta,
      fase: statusDaProposta === proposta.status ? fase : faseDoItem(statusDaProposta, tipoDoDocumento),
      itens: [...porId.values()].map((it) => ({ id: it.id, status: it.status })),
    },
    { requestId },
  );
}
