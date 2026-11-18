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
 * A regra inteira mora em `lib/propostas/mudar-status-dos-itens.ts`; esta rota
 * só autentica, valida o corpo e traduz a resposta. Sessão (a tela) OU
 * `Bearer dsk_…` com `mcp:write` (`mudarStatusDosItensPorToken`, a porta do ERP).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { extractBearer } from "@/lib/mcp/auth";
import { mudarStatusDosItens } from "@/lib/propostas/mudar-status-dos-itens";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { statusDosItensSchema } from "@/lib/schemas/propostas";
import { createAdminClient } from "@/lib/supabase/admin";

import { mudarStatusDosItensPorToken } from "../../_por-token";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  // Integração (ERP) por `Bearer dsk_…` + `mcp:write`: mesma regra, outra porta.
  if (extractBearer(req.headers.get("authorization"))) return mudarStatusDosItensPorToken(req, (await ctx.params).id);

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

  const parsed = statusDosItensSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const saida = await mudarStatusDosItens({
    db: createAdminClient(),
    organizationId: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
    propostaId: id,
    itens: parsed.data.itens,
    via: "tela",
  });
  if (!saida.ok) {
    return fail(saida.code, t(saida.message), saida.httpStatus, {
      requestId,
      ...(saida.details ? { details: saida.details } : {}),
    });
  }
  return ok(saida.resultado, { requestId });
}
