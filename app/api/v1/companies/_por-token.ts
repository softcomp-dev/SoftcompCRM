/**
 * Empresas (B2B) chamadas por Bearer `dsk_…` — a porta do ERP.
 *
 * O módulo `crm_b2b` é opcional e desligado de fábrica: quem decide isso é a
 * rota (`seModuloB2bDesligado`), ANTES de olhar de onde veio a identidade, então
 * sessão e token recebem o mesmo 404 quando o módulo está desligado.
 *
 * Os handlers (`lib/crm-b2b/companies-handler.ts`) são os mesmos da tela e
 * filtram `organization_id` em toda consulta; aqui a organização sai da LINHA
 * DO TOKEN (`resolveAuthDual`), nunca do corpo. O client do token é o de
 * serviço (ignora a RLS), então esse filtro é a única fronteira.
 *
 * DELETE não tem porta por token: apagar empresa fica com a sessão.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ZodError } from "zod";

import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import { falhaDoHandlerParaToken } from "@/lib/api/integracao-por-token";
import { resolveAuthDual, tetoDeEscritaDoToken, type AuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  createCompanyHandler,
  getCompanyHandler,
  listCompaniesHandler,
  patchCompanyHandler,
} from "@/lib/crm-b2b/companies-handler";
import { requireSupportWrite } from "@/lib/impersonate/support";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Autorizado = Extract<AuthDual, { ok: true }>;

function requestIdDe(req: NextRequest): string {
  return req.headers.get("x-request-id") ?? randomUUID();
}

/** Erro de handler/validação → resposta para quem integra (5xx sem texto do banco). */
function falha(err: unknown, requestId: string, rota: string): Response {
  if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, rota);
  if (err instanceof ZodError) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: { issues: err.issues },
    });
  }
  throw err;
}

/** O handler audita com `actorUserId` (nulo para token); este registro leva o token como ator. */
function auditarPorToken(
  authz: Autorizado,
  action: "companies.created" | "companies.updated",
  companyId: string,
  requestId: string,
): void {
  void audit({
    action,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "companies",
    resourceId: companyId,
    metadata: { via: "token" },
    requestId,
  });
}

export async function listarPorToken(req: NextRequest): Promise<Response> {
  const requestId = requestIdDe(req);
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  // Leitura por token também conta no teto (o desenho de GET /pipelines): rota
  // em PUBLIC_PATHS não tem contagem a montante.
  const tetoDeLeitura = await tetoDeEscritaDoToken(authz, "companies_leitura", requestId);
  if (tetoDeLeitura) return tetoDeLeitura;

  try {
    const search = req.nextUrl.searchParams.get("search") ?? undefined;
    const limitBruto = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitBruto) && limitBruto > 0 ? Math.floor(limitBruto) : 50;
    const result = await listCompaniesHandler(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      { search, limit },
    );
    return ok(result.companies, { requestId, meta: { has_more: result.has_more } });
  } catch (err) {
    return falha(err, requestId, "GET /api/v1/companies");
  }
}

export async function lerPorToken(req: NextRequest, id: string): Promise<Response> {
  const requestId = requestIdDe(req);
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  // Leitura por token também conta no teto (o desenho de GET /pipelines): rota
  // em PUBLIC_PATHS não tem contagem a montante.
  const tetoDeLeitura = await tetoDeEscritaDoToken(authz, "companies_leitura", requestId);
  if (tetoDeLeitura) return tetoDeLeitura;
  if (!UUID.test(id)) return fail("not_found", "Empresa não encontrada.", 404, { requestId });

  try {
    const data = await getCompanyHandler(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      id,
    );
    return ok(data, { requestId });
  } catch (err) {
    return falha(err, requestId, "GET /api/v1/companies/{id}");
  }
}

export async function criarPorToken(req: NextRequest): Promise<Response> {
  const requestId = requestIdDe(req);
  // Criar empresa pede `manager` na tela; o token pede o mesmo, senão a rota
  // vira atalho para quem a tela barra.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const suporte = await requireSupportWrite();
  if (suporte) return suporte;

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !UUID.test(chave)) {
    return fail("validation_failed", "Idempotency-Key deve ser um UUID.", 400, { requestId });
  }
  const teto = await tetoDeEscritaDoToken(authz, "companies", requestId);
  if (teto) return teto;

  const corpo: unknown = await req.json().catch(() => undefined);
  if (corpo === undefined || corpo === null || typeof corpo !== "object") {
    return fail("invalid_request", "Corpo JSON inválido.", 400, { requestId });
  }

  const criar = async () => {
    const data = await createCompanyHandler(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      // Token não é usuário: `created_by` (FK para auth.users) fica nulo.
      null as unknown as string,
      corpo,
    );
    auditarPorToken(authz, "companies.created", String((data as { id: string }).id), requestId);
    return { resposta: data as Record<string, unknown>, status: 201 };
  };

  try {
    const desfecho: DesfechoIdempotente<Record<string, unknown>> =
      chave === null
        ? { tipo: "executou", ...(await criar()) }
        : await comIdempotencia({
            db: authz.supabase,
            organizationId: authz.organizationId,
            endpoint: "POST /api/v1/companies",
            chave,
            corpo,
            executar: criar,
          });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        "Esta Idempotency-Key já foi usada com outro corpo. Gere uma chave nova para um pedido diferente.",
        409,
        { requestId },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        "O mesmo pedido ainda está sendo processado. Tente de novo em instantes, com a mesma chave.",
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    return falha(err, requestId, "POST /api/v1/companies");
  }
}

export async function editarPorToken(req: NextRequest, id: string): Promise<Response> {
  const requestId = requestIdDe(req);
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const suporte = await requireSupportWrite();
  if (suporte) return suporte;
  const teto = await tetoDeEscritaDoToken(authz, "companies", requestId);
  if (teto) return teto;
  if (!UUID.test(id)) return fail("not_found", "Empresa não encontrada.", 404, { requestId });

  const corpo: unknown = await req.json().catch(() => undefined);
  if (corpo === undefined || corpo === null || typeof corpo !== "object") {
    return fail("invalid_request", "Corpo JSON inválido.", 400, { requestId });
  }

  try {
    const data = await patchCompanyHandler(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      null as unknown as string,
      id,
      corpo,
    );
    auditarPorToken(authz, "companies.updated", id, requestId);
    return ok(data, { requestId });
  } catch (err) {
    return falha(err, requestId, "PATCH /api/v1/companies/{id}");
  }
}
