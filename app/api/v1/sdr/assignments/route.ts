/**
 * /api/v1/sdr/assignments — quem é SDR nesta empresa.
 *
 * GET  manager+, função ligada: os membros marcados, cada um com `active` e
 *      `inactive_reason` calculados (`lib/sdr/permissoes.ts`) — um SDR
 *      rebaixado a viewer aparece, mas como inativo, para quem gerencia ver
 *      por que ele não recebe lead. Mínimo de dado pessoal: nome, sem e-mail
 *      (mesma régua de `team/assignable`).
 * POST admin, função ligada: `{ user_id }` marca o membro. 201 quando marcou,
 *      200 quando já era SDR (idempotente, sem nova auditoria).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { listarMarcados, marcarSdr } from "@/lib/sdr/atribuicao";
import { PAPEL_MINIMO_DO_SDR, motivoSdrInativo } from "@/lib/sdr/permissoes";
import { createAdminClient } from "@/lib/supabase/admin";

import { interruptorDaOrganizacao } from "../_shared";

export const dynamic = "force-dynamic";

const postSchema = z.object({ user_id: z.string().uuid() }).strict();

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const db = createAdminClient();
  const funcao = await interruptorDaOrganizacao(db, orgId, authz.user.idioma, requestId, { exigirLigada: true });
  if (!funcao.ok) return funcao.response;

  const lidos = await listarMarcados(db, orgId);
  if (!lidos.ok) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });

  const nomes = new Map<string, string | null>();
  if (isServiceRoleConfigured()) {
    await Promise.all(
      lidos.membros.map(async (m) => {
        const { data } = await db.auth.admin.getUserById(m.user_id);
        nomes.set(m.user_id, (data?.user?.user_metadata?.full_name as string | undefined) ?? null);
      }),
    );
  }

  return ok(
    lidos.membros.map((m) => {
      const motivo = motivoSdrInativo(m, true);
      return {
        user_id: m.user_id,
        full_name: nomes.get(m.user_id) ?? null,
        role: m.role,
        assigned_since: m.sdr_since,
        active: motivo === null,
        inactive_reason: motivo,
      };
    }),
    { requestId, meta: { total: lidos.membros.length } },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const db = createAdminClient();
  const funcao = await interruptorDaOrganizacao(db, orgId, authz.user.idioma, requestId, { exigirLigada: true });
  if (!funcao.ok) return funcao.response;

  const r = await marcarSdr(db, orgId, parsed.data.user_id);
  switch (r.tipo) {
    case "marcado":
      void audit({
        action: "sdr.assigned",
        actorUserId: authz.user.id,
        organizationId: orgId,
        resourceType: "membership",
        resourceId: r.membro.user_id,
        requestId,
        metadata: { target_user_id: r.membro.user_id, role: r.membro.role },
      });
      return ok(respostaDoMembro(r.membro), { requestId, status: 201 });
    case "ja_marcado":
      return ok(respostaDoMembro(r.membro), { requestId });
    case "nao_encontrado":
      return fail("not_found", t("Membro não encontrado."), 404, { requestId });
    case "revogado":
      return fail("state_conflict", t("Membro está revogado."), 409, { requestId });
    case "papel_insuficiente":
      return fail("sdr_role_ineligible", t("Este papel não pode ser SDR. Mude o papel para Atendente ou acima."), 422, {
        requestId,
        details: { role: r.role, minimum_role: PAPEL_MINIMO_DO_SDR },
      });
    case "conflito":
      return fail("conflict", t("A configuração mudou. Recarregue a página e tente novamente."), 409, { requestId });
    default:
      return fail("internal_error", t("Falha ao salvar."), 500, { requestId });
  }
}

function respostaDoMembro(m: { user_id: string; role: string; revoked_at: string | null; sdr_since: string | null }) {
  const motivo = motivoSdrInativo(m, true);
  return {
    user_id: m.user_id,
    role: m.role,
    assigned_since: m.sdr_since,
    active: motivo === null,
    inactive_reason: motivo,
  };
}
