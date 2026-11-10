import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/[user_id]/revoke — revoke a member.
 *
 * Guardrails:
 *  - Caller must be admin of the active org.
 *  - Cannot revoke self.
 *  - Cannot revoke the last admin.
 *  - The member's push subscriptions in this org are removed with the membership.
 *
 * O efeito (último admin, conversas liberadas, push, audit) mora em
 * `lib/team/revogar-vinculo.ts`, compartilhado com a tela de Vínculos do /admin.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { revogarVinculo } from "@/lib/team/revogar-vinculo";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;
  if (targetUserId === authUser.id) {
    return fail("state_conflict", t("Não é possível revogar o próprio acesso."), 409, { requestId });
  }

  const supabase = await createClient();
  const r = await revogarVinculo(supabase, {
    organizationId: activeOrg.orgId,
    targetUserId,
    actor: { id: authUser.id, role: activeOrg.role },
    requestId,
  });
  if (!r.ok) {
    if (r.motivo === "nao_encontrado") {
      return fail("not_found", t("Membro não encontrado."), 404, { requestId });
    }
    if (r.motivo === "ultimo_admin") {
      return fail(
        "state_conflict",
        t("Não é possível revogar o último admin do tenant."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", r.detalhe ?? "revoke_failed", 500, { requestId });
  }
  if (r.jaRevogado) {
    return ok({ user_id: targetUserId, already_revoked: true }, { requestId });
  }
  return ok({ user_id: targetUserId, revoked_at: r.revokedAt }, { requestId });
}
