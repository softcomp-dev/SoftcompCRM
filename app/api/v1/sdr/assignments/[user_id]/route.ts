/**
 * DELETE /api/v1/sdr/assignments/[user_id] — desmarca um SDR (admin, função
 * ligada). Vale também para membro revogado: é limpeza, não concessão.
 * Desmarcar quem não é SDR responde 200 com o estado atual, sem auditar.
 *
 * Só a marca sai: o vínculo, o papel e os leads de que ele é responsável
 * continuam onde estão. Passar a carteira adiante é decisão de quem opera
 * (automação "SDR → Closer", #3514), não efeito colateral desta rota.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { desmarcarSdr } from "@/lib/sdr/atribuicao";
import { createAdminClient } from "@/lib/supabase/admin";

import { interruptorDaOrganizacao } from "../../_shared";

export const dynamic = "force-dynamic";

const userIdSchema = z.string().uuid();

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { user_id } = await ctx.params;
  const alvo = userIdSchema.safeParse(user_id);
  if (!alvo.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const db = createAdminClient();
  const funcao = await interruptorDaOrganizacao(db, orgId, authz.user.idioma, requestId, { exigirLigada: true });
  if (!funcao.ok) return funcao.response;

  const r = await desmarcarSdr(db, orgId, alvo.data);
  switch (r.tipo) {
    case "desmarcado":
      void audit({
        action: "sdr.unassigned",
        actorUserId: authz.user.id,
        organizationId: orgId,
        resourceType: "membership",
        resourceId: r.membro.user_id,
        requestId,
        metadata: { target_user_id: r.membro.user_id },
      });
      return ok({ user_id: r.membro.user_id, assigned: false }, { requestId });
    case "nao_marcado":
      return ok({ user_id: r.membro.user_id, assigned: false }, { requestId });
    case "nao_encontrado":
      return fail("not_found", t("Membro não encontrado."), 404, { requestId });
    case "conflito":
      return fail("conflict", t("A configuração mudou. Recarregue a página e tente novamente."), 409, { requestId });
    default:
      return fail("internal_error", t("Falha ao salvar."), 500, { requestId });
  }
}
