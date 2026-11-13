import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/leads/[id] — lê o negócio (sessão ou token `mcp:read`).
 * PATCH /api/v1/leads/[id] — update lead (handler em ../_handler.ts).
 *
 * Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
 * mesma dualidade de `/api/v1/messages`: a integração de monitoramento
 * processual (n8n consultando Escavador/Jusbrasil/Codilo/Judit) atualiza o
 * campo personalizado "Andamento atual" por aqui, sem navegador. A org nunca
 * vem do corpo — no ramo do token ela sai da linha do token
 * (`lib/api/auth-dual.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import { updateLeadSchema, validateRequest } from "@/lib/schemas";

import { getLeadHandler, updateLeadHandler } from "../_handler";
import { enriquecerNegocios, resolverAuthDeLeitura } from "../_leitura";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * LER UM NEGÓCIO (viewer+, sessão ou `Bearer dsk_…` com `mcp:read`).
 *
 * Mesmo `getLeadHandler` da tool MCP `crm_get_lead`: negócio de outra
 * organização ou de contato pessoal é 404 (nunca confirma que existe), e a
 * prova interna de meta não sai. Acrescenta o nome da etapa, do funil e do dono.
 * Com sessão a RLS decide o que se vê (inclusive o "só os seus").
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await resolverAuthDeLeitura(req, requestId);
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  // Um id que nem é UUID não existe: 404 igual ao de quem não achou, e não o 500
  // do Postgres ao comparar texto com uuid.
  if (!UUID.test(leadId)) {
    return fail("not_found", traduzir("Lead não encontrado.", idioma ?? "pt-BR"), 404, { requestId });
  }

  try {
    const lead = await getLeadHandler(
      supabase,
      { organization_id: organizationId, actor, requestId, idioma },
      leadId,
    );
    const [completo] = await enriquecerNegocios(supabase, organizationId, [lead]);
    return ok(completo, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "leads", requestId);
  if (tetoEstourado) return tetoEstourado;

  let input;
  try {
    input = await validateRequest(updateLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const updated = await updateLeadHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      leadId,
      input,
    );
    return ok(updated, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
