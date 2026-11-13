import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/win
 *
 * Closes a lead as won by moving it to the pipeline's `is_won=true` stage.
 * The DB trigger `fn_crm_lead_close_on_stage` sets status='won' + closed_at (P-02).
 * Idempotent: already-won leads return 200 with the current row.
 *
 * A regra vive em `lib/leads/encerramento.ts`, compartilhada com a capacidade de
 * encerramento da IA (IA 360 · wave 2). Duas implementações fariam a IA e o
 * humano fecharem negócio por critérios diferentes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { falhaDoHandlerParaToken } from "@/lib/api/integracao-por-token";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { extractBearer } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GANHAR POR TOKEN (`Bearer dsk_…` com `mcp:write`, papel `agent`). O ERP
 * fecha "pedido faturado" numa chamada, sem conhecer o id da etapa de ganho:
 * quem a acha é `encerraDemanda`, a MESMA função do ramo da sessão — motivo de
 * ganho do vocabulário do funil, campos exigidos (`details.faltando`) e
 * idempotência (já ganho devolve 200).
 *
 * O client do token ignora a RLS: `encerraDemanda` filtra `organization_id` em
 * toda leitura e escrita, com a org da LINHA DO TOKEN. Lead de outra
 * organização é 404, nunca o dado.
 */
async function ganharPorToken(req: NextRequest, leadId: string, requestId: string): Promise<Response> {
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

  // Corpo opcional, como no ramo da sessão; mas JSON malformado, campo que não
  // existe ou `won_reason` que não é texto são recusados em vez de ignorados.
  const bruto = await req.text();
  let corpo: unknown = {};
  if (bruto.trim() !== "") {
    try {
      corpo = JSON.parse(bruto);
    } catch {
      return fail("body_malformed", "Body must be valid JSON", 400, { requestId });
    }
  }
  const parsed = z
    .object({ won_reason: z.string().max(500).nullish() })
    .strict()
    .safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  try {
    const { lead } = await encerraDemanda(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      { leadId, desfecho: "won", motivo: parsed.data.won_reason ?? null },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, "POST /api/v1/leads/{id}/win");
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
    return ganharPorToken(req, leadId, requestId);
  }

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  // O MOTIVO DE GANHO (issue #1536): corpo opcional. Body vazio/ausente é o
  // contrato antigo — ganhar sem motivo continua valendo, salvo quando o funil
  // liga `settings.won_reason_required` (aí a recusa vem de `encerraDemanda`).
  const corpo = await req.json().catch(() => ({}));
  const wonReason =
    typeof (corpo as { won_reason?: unknown }).won_reason === "string"
      ? ((corpo as { won_reason: string }).won_reason as string)
      : null;

  try {
    const { lead } = await encerraDemanda(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      { leadId, desfecho: "won", motivo: wonReason },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
