import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * VÍNCULOS DE UMA CONTA COM AS EMPRESAS — tela /admin/vinculos.
 *
 *   GET    /api/v1/admin/users/[id]/vinculos                     — todas as empresas + os vínculos da conta
 *   POST   /api/v1/admin/users/[id]/vinculos                     — liga a conta a N empresas, com um papel
 *   PATCH  /api/v1/admin/users/[id]/vinculos                     — troca o papel numa empresa
 *   DELETE /api/v1/admin/users/[id]/vinculos?organization_id=…   — tira a conta de uma empresa
 *
 * Só o dono da instalação (platform admin). Escrita exige scope `full` + MFA
 * (`requirePlatformAdminEscrita`). O client é o de SERVIÇO: quem decide é a
 * plataforma, não a RLS de uma empresa — e por isso toda consulta aqui filtra
 * `user_id` (do path) e `organization_id` (do corpo, conferido contra
 * `organizations`) explicitamente.
 *
 * Vincular é DIRETO, sem convite: a conta já existe (ver `lib/admin/vinculos.ts`).
 * Revogar passa por `lib/team/revogar-vinculo.ts`, o mesmo efeito da Equipe.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import {
  desvincularQuerySchema,
  planejarVinculos,
  rebaixariaUltimoAdmin,
  trocarPapelSchema,
  vincularSchema,
  type VinculoExistente,
} from "@/lib/admin/vinculos";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import type { Role } from "@/lib/auth/types";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { createAdminClient } from "@/lib/supabase/admin";
import { revogarVinculo } from "@/lib/team/revogar-vinculo";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
type Admin = ReturnType<typeof createAdminClient>;

/** A conta existe no provedor de auth? Sem ela não há o que vincular. */
async function contaExiste(admin: Admin, userId: string): Promise<boolean> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  return !error && !!data?.user;
}

async function vinculosDaConta(admin: Admin, userId: string) {
  return admin
    .from("user_organizations")
    .select("id, organization_id, role, revoked_at, accepted_at")
    .eq("user_id", userId);
}

async function adminsAtivos(admin: Admin, organizationId: string) {
  return admin
    .from("user_organizations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null);
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id: userId } = await params;
  try {
    await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  if (!(await contaExiste(admin, userId))) {
    return fail("not_found", "Usuário não encontrado.", 404, { requestId });
  }

  const [orgs, vinculos] = await Promise.all([
    admin
      .from("organizations")
      .select("id, display_name, slug, status")
      .order("display_name", { ascending: true })
      .limit(5000),
    vinculosDaConta(admin, userId),
  ]);
  if (orgs.error) return fail("internal_error", orgs.error.message, 500, { requestId });
  if (vinculos.error) return fail("internal_error", vinculos.error.message, 500, { requestId });

  return ok(
    {
      empresas: orgs.data ?? [],
      vinculos: (vinculos.data ?? []).map((v) => ({
        organization_id: v.organization_id,
        role: v.role,
        revoked_at: v.revoked_at,
        accepted_at: v.accepted_at,
      })),
    },
    { requestId },
  );
}

// ─── POST — vincular ────────────────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id: userId } = await params;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = vincularSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Corpo inválido.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { organization_ids, role } = parsed.data;

  const admin = createAdminClient();
  if (!(await contaExiste(admin, userId))) {
    return fail("not_found", "Usuário não encontrado.", 404, { requestId });
  }

  const [orgs, vinculos] = await Promise.all([
    admin.from("organizations").select("id").in("id", organization_ids),
    vinculosDaConta(admin, userId),
  ]);
  if (orgs.error) return fail("internal_error", orgs.error.message, 500, { requestId });
  if (vinculos.error) return fail("internal_error", vinculos.error.message, 500, { requestId });

  const passos = planejarVinculos(
    organization_ids,
    (vinculos.data ?? []) as VinculoExistente[],
    new Set((orgs.data ?? []).map((o) => o.id as string)),
  );

  invalidarUsuario(userId);
  const nowIso = new Date().toISOString();
  const vinculadas: string[] = [];
  const jaAtivas: string[] = [];
  const falhas: Array<{ organization_id: string; motivo: string }> = [];

  for (const passo of passos) {
    if (passo.tipo === "empresa_inexistente") {
      falhas.push({ organization_id: passo.organizationId, motivo: "Empresa não encontrada." });
      continue;
    }
    if (passo.tipo === "ja_ativo") {
      jaAtivas.push(passo.organizationId);
      continue;
    }

    const escrita =
      passo.tipo === "criar"
        ? await admin
            .from("user_organizations")
            .insert({
              user_id: userId,
              organization_id: passo.organizationId,
              role,
              invited_by: adminCtx.user.id,
              invited_at: nowIso,
              accepted_at: nowIso,
            })
            .select("id")
            .single()
        : await admin
            .from("user_organizations")
            .update({ revoked_at: null, role, updated_at: nowIso })
            .eq("id", passo.vinculoId)
            .eq("user_id", userId)
            .eq("organization_id", passo.organizationId)
            .select("id")
            .single();

    if (escrita.error) {
      // O gatilho de assentos do plano recusa com PT402 quando a empresa já
      // está no teto — instrução para quem clicou, não erro interno.
      const limite = traduzirLimiteDoPlano(escrita.error, "pt-BR");
      falhas.push({
        organization_id: passo.organizationId,
        motivo: limite ? limite.message : escrita.error.message,
      });
      continue;
    }

    vinculadas.push(passo.organizationId);
    await audit({
      action: passo.tipo === "criar" ? "member.linked" : "member.reactivated",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: passo.organizationId,
      resourceType: "membership",
      resourceId: escrita.data.id as string,
      requestId,
      metadata: {
        target_user_id: userId,
        role,
        via: "admin_vinculos",
        ...(passo.tipo === "reativar" ? { previous_role: passo.papelAnterior } : {}),
      },
    });
  }
  invalidarUsuario(userId);

  return ok({ vinculadas, ja_ativas: jaAtivas, falhas }, { requestId });
}

// ─── PATCH — trocar papel ───────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id: userId } = await params;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = trocarPapelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Corpo inválido.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { organization_id, role } = parsed.data;

  const admin = createAdminClient();
  const { data: alvo, error } = await admin
    .from("user_organizations")
    .select("id, role, revoked_at")
    .eq("user_id", userId)
    .eq("organization_id", organization_id)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!alvo || alvo.revoked_at) {
    return fail("not_found", "Vínculo ativo não encontrado.", 404, { requestId });
  }
  if (alvo.role === role) return ok({ organization_id, role, unchanged: true }, { requestId });

  const { count, error: countErr } = await adminsAtivos(admin, organization_id);
  if (countErr) return fail("internal_error", countErr.message, 500, { requestId });
  if (rebaixariaUltimoAdmin(alvo.role as Role, role, count ?? 0)) {
    return fail(
      "state_conflict",
      "Não é possível rebaixar o último admin da empresa.",
      409,
      { requestId },
    );
  }

  invalidarUsuario(userId);
  const { error: updErr } = await admin
    .from("user_organizations")
    .update({ role, updated_at: new Date().toISOString() })
    .eq("id", alvo.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
  invalidarUsuario(userId);

  await audit({
    action: "member.role_changed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: organization_id,
    resourceType: "membership",
    resourceId: alvo.id as string,
    requestId,
    metadata: { target_user_id: userId, from: alvo.role, to: role, via: "admin_vinculos" },
  });

  return ok({ organization_id, role }, { requestId });
}

// ─── DELETE — desvincular ───────────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id: userId } = await params;

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = desvincularQuerySchema.safeParse({
    organization_id: new URL(req.url).searchParams.get("organization_id"),
  });
  if (!parsed.success) {
    return fail("validation_failed", "organization_id inválido.", 422, { requestId });
  }

  const r = await revogarVinculo(createAdminClient(), {
    organizationId: parsed.data.organization_id,
    targetUserId: userId,
    // Na linha do tempo da conversa liberada, quem age é a plataforma.
    actor: { id: adminCtx.user.id, role: "admin" },
    requestId,
    comoPlatformAdmin: true,
  });
  if (!r.ok) {
    if (r.motivo === "nao_encontrado") {
      return fail("not_found", "Vínculo não encontrado.", 404, { requestId });
    }
    if (r.motivo === "ultimo_admin") {
      return fail(
        "state_conflict",
        "Não é possível tirar o último admin da empresa.",
        409,
        { requestId },
      );
    }
    return fail("internal_error", r.detalhe ?? "revoke_failed", 500, { requestId });
  }
  return ok(
    { organization_id: parsed.data.organization_id, revoked_at: r.revokedAt, already_revoked: r.jaRevogado },
    { requestId },
  );
}
