import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { aplicarEfeitosDaDecisao } from "@/lib/propostas/efeitos-da-decisao";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

export const dynamic = "force-dynamic";
const bodySchema = z.object({
  decisao: z.enum(["aceita", "recusada"]),
  motivo: z.string().max(1000).optional(),
});
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_proposals" });
  if (!authz.ok) return authz.response;
  const desligada = await sePropostasDesligadas(authz.org.orgId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const supabase = await createClient();
  const { data: proposta, error } = await supabase
    .from("crm_proposals")
    .update({
      status: parsed.data.decisao,
      decided_at: new Date().toISOString(),
      decided_by_user_id: authz.user.id,
      decision_reason: parsed.data.motivo ?? null,
    })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .eq("status", "enviada")
    .select("id, lead_id, contact_id, retorno_id")
    .maybeSingle();
  if (error) return fail("internal_error", t("Falha ao registrar a decisão."), 500, { requestId });
  if (!proposta) {
    return fail("proposal_context_stale", t("Só é possível decidir sobre uma proposta enviada."), 409, { requestId });
  }

  await aplicarEfeitosDaDecisao({
    db: supabase,
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    requestId,
    proposta: proposta as { id: string; lead_id: string | null; contact_id: string | null; retorno_id: string | null },
    decisao: parsed.data.decisao,
    motivo: parsed.data.motivo,
  });

  return ok({ id, status: parsed.data.decisao }, { requestId });
}
