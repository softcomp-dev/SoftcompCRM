import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  createCompanyHandler,
  listCompaniesHandler,
} from "@/lib/crm-b2b/companies-handler";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import { extractBearer } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";

import { criarPorToken, listarPorToken } from "./_por-token";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  // Bearer `dsk_…` (ERP): mesmo módulo, outra porta de identidade.
  if (extractBearer(req.headers.get("authorization"))) return listarPorToken(req);
  const authz = await requireRole("viewer", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;

  try {
    const supabase = await createClient();
    const search = req.nextUrl.searchParams.get("search") ?? undefined;
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const ctx = ctxFromAuthz(authz, requestId);
    const result = await listCompaniesHandler(supabase, ctx, { search, limit });
    return ok(result.companies, { requestId, meta: { has_more: result.has_more } });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  if (extractBearer(req.headers.get("authorization"))) return criarPorToken(req);
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("manager", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const ctx = ctxFromAuthz(authz, requestId);
    const data = await createCompanyHandler(supabase, ctx, authz.user.id, body);
    return ok(data, { requestId, status: 201 });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
