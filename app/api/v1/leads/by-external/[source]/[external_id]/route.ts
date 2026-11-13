/**
 * GET /api/v1/leads/by-external/{source}/{external_id} — o negócio pelo id que o
 * sistema de fora (ERP) lhe deu.
 *
 * Sessão (viewer+) ou `Bearer dsk_…` com `mcp:read`. O par (`source`,
 * `external_id`) é único por organização (`uniq_crm_leads_org_source_external`).
 * Resposta idêntica à de GET /api/v1/leads/{id}; 404 se o par não existe na
 * organização de quem chama — ou se o negócio é de contato pessoal.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";

import { getLeadHandler, leadDaOrigemExterna } from "../../../_handler";
import { enriquecerNegocios, resolverAuthDeLeitura } from "../../../_leitura";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ source: string; external_id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { source, external_id: externalId } = await ctx.params;

  const authz = await resolverAuthDeLeitura(req, requestId);
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;
  const naoAchou = () =>
    fail("not_found", traduzir("Lead não encontrado.", idioma ?? "pt-BR"), 404, { requestId });

  try {
    // Com sessão a RLS esconde o par que o usuário não enxerga: mesmo 404.
    const leadId = await leadDaOrigemExterna(supabase, organizationId, source, externalId);
    if (!leadId) return naoAchou();

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
