/**
 * GET /api/v1/team/assignable — destinos válidos de transferência de conversa
 * (G3-01, ReassignDialog): membros ativos agent+ da org ativa.
 *
 * Exceção deliberada e MÍNIMA à matriz spec 13 §4 (team read = manager+): um
 * agent precisa escolher o destino pra transferir (decisão G1-06d). Exposto o
 * mínimo — user_id, nome e role. Sem e-mail, sem last_sign_in (LGPD/PII).
 *
 * Por Bearer `dsk_…` (`mcp:read`, papel viewer) a integração de servidor (ERP)
 * também lê esta lista para escolher o responsável de um negócio. Só nesse ramo
 * a resposta leva `email`: é a chave com que o ERP casa o vendedor dele, e quem
 * chama é um token que o administrador emitiu para a organização. O ramo da
 * sessão (a tela) segue sem e-mail, como sempre foi.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/audit";

export const dynamic = "force-dynamic";

interface AssignableMember {
  user_id: string;
  role: string;
  full_name: string | null;
  email?: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // A sessão continua exigindo agent (o mesmo `requireRole` de antes); o token
  // só precisa de viewer, porque ele LÊ a lista e não age como atendente.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "team",
    role: "agent",
    scope: "mcp:read",
    tokenRole: "viewer",
  });
  if (!authz.ok) return authz.response;
  // Leitura por token também conta no teto (o mesmo de GET /pipelines): rota
  // em PUBLIC_PATHS não tem contagem a montante, e um laço do ERP sem teto
  // martelaria o banco (tests/unit/rotas-bearer-aplicam-teto-de-escrita.test.ts).
  const tetoEstourado = await tetoDeEscritaDoToken(authz, "team_leitura", requestId);
  if (tetoEstourado) return tetoEstourado;
  const porToken = authz.via === "token";
  const orgId = authz.organizationId; // fonte confiável (cookie validado ou linha do token)

  // A RLS de user_organizations só mostra o próprio membership a um agent —
  // admin client filtrado manualmente pela org resolvida acima (doutrina:
  // service role + filtro explícito de organization_id de fonte confiável).
  const client = porToken
    ? authz.supabase
    : isServiceRoleConfigured()
      ? createAdminClient()
      : await createClient();
  let consulta = client
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", orgId)
    .is("revoked_at", null)
    .neq("role", "viewer");
  // Convite pendente não é responsável possível: o ERP não pode atribuir um
  // negócio a quem ainda não entrou. A tela não mudou, então só o token filtra.
  if (porToken) consulta = consulta.not("accepted_at", "is", null);
  const { data: rows, error } = await consulta.order("created_at", { ascending: true });

  if (error) {
    // O texto do banco só vai a quem está numa sessão; o integrador recebe o
    // X-Request-Id, que é o que o operador procura no log.
    return fail("internal_error", porToken ? "Erro interno ao listar a equipe." : error.message, 500, {
      requestId,
    });
  }

  const memberships = (rows ?? []) as Array<{ user_id: string; role: string }>;

  if (!isServiceRoleConfigured() || memberships.length === 0) {
    const degraded: AssignableMember[] = memberships.map((m) => ({
      ...m,
      full_name: null,
      ...(porToken ? { email: null } : {}),
    }));
    return ok(degraded, { requestId });
  }

  const admin = createAdminClient();
  const members: AssignableMember[] = await Promise.all(
    memberships.map(async (m) => {
      const { data: userRes } = await admin.auth.admin.getUserById(m.user_id);
      return {
        ...m,
        full_name: (userRes?.user?.user_metadata?.full_name as string | undefined) ?? null,
        ...(porToken ? { email: userRes?.user?.email ?? null } : {}),
      };
    }),
  );
  return ok(members, { requestId });
}
