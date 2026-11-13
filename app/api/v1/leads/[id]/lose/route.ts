import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/lose
 *
 * Closes a lead as lost (P-02). P-03 requires `lost_reason` (validated by Zod).
 * Moves the lead to the pipeline's `is_lost=true` stage; trigger
 * `fn_crm_lead_close_on_stage` sets status='lost' + closed_at.
 *
 * A regra vive em `lib/leads/encerramento.ts`, compartilhada com a capacidade de
 * encerramento da IA (IA 360 · wave 2). Duas implementações fariam a IA e o
 * humano fecharem negócio por critérios diferentes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { falhaDoHandlerParaToken } from "@/lib/api/integracao-por-token";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { extractBearer } from "@/lib/mcp/auth";
import { traduzir } from "@/lib/i18n/dicionario";
import { loseLeadSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PERDER POR TOKEN (`Bearer dsk_…` com `mcp:write`, papel `agent`). O ERP fecha
 * "pedido cancelado" numa chamada, sem conhecer o id da etapa de perda. A regra
 * é a do ramo da sessão (`encerraDemanda`): motivo obrigatório, vocabulário do
 * funil (422 `lost_reason_invalid`), campos exigidos, idempotência. O filtro de
 * `organization_id` é o da LINHA DO TOKEN, porque o client de serviço ignora a RLS.
 */
async function perderPorToken(req: NextRequest, leadId: string, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "leads", requestId);
  if (tetoEstourado) return tetoEstourado;

  if (!UUID.test(leadId)) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  try {
    const input = await validateRequest(loseLeadSchema, req);
    const { lead } = await encerraDemanda(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      { leadId, desfecho: "lost", motivo: input.lost_reason },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const fieldErrors = (err.details as { fieldErrors?: Record<string, unknown> } | undefined)?.fieldErrors;
      if (err.code === "validation_error" && fieldErrors && "lost_reason" in fieldErrors) {
        return fail("lost_reason_required", "Informe o motivo da perda.", 422, { requestId });
      }
      return falhaDoHandlerParaToken(err, requestId, "POST /api/v1/leads/{id}/lose");
    }
    throw err;
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  if (extractBearer(req.headers.get("authorization"))) {
    return perderPorToken(req, leadId, requestId);
  }

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  try {
    const input = await validateRequest(loseLeadSchema, req);
    const { lead } = await encerraDemanda(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      { leadId, desfecho: "lost", motivo: input.lost_reason },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const fieldErrors = (err.details as { fieldErrors?: Record<string, unknown> } | undefined)?.fieldErrors;
      if (err.code === "validation_error" && fieldErrors && "lost_reason" in fieldErrors) {
        return fail("lost_reason_required", t("Informe o motivo da perda."), 422, { requestId });
      }
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
