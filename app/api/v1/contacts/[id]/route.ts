import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/contacts/[id] — fetch single (handler em ../_handler.ts)
 * PATCH  /api/v1/contacts/[id] — update (handler em ../_handler.ts)
 * DELETE /api/v1/contacts/[id] — remove (handler em ../_handler.ts)
 *
 * Thin wrapper: auth + Zod + ok/fail. Decrypt CPF + LGPD irreversibility no handler.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { ok, fail, noContent } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { falhaDoHandlerParaToken } from "@/lib/api/integracao-por-token";
import { extractBearer } from "@/lib/mcp/auth";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { contactPatchSchemaDoPais, validateRequest } from "@/lib/schemas";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { createClient } from "@/lib/supabase/server";

import { deleteContactHandler, getContactHandler, patchContactHandler } from "../_handler";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Os telefones da ficha além do principal (Spec 31, B1), e o tipo e o WhatsApp
 * do principal, que o handler da ficha não seleciona. O filtro de organização é
 * EXPLÍCITO nas duas leituras: o cliente de sessão tem RLS, mas a regra do
 * repositório é não depender só dela. `wa_lid` fica de fora de propósito: é o
 * identificador do WhatsApp daquele número, e a API não precisa dele.
 */
async function telefonesDaFicha(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  requestId: string,
): Promise<{
  phone_type: string | null;
  phone_whatsapp: string | null;
  additional_phones: Array<{
    id: string;
    phone_number: string;
    type: string;
    whatsapp: string;
    label: string | null;
    origin: string;
    created_at: string;
  }>;
}> {
  const { data: principal, error: errPrincipal } = await supabase
    .from("contacts")
    .select("phone_type, phone_whatsapp")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  const { data: extras, error: errExtras } = await supabase
    .from("contact_phones")
    .select("id, phone_number, tipo, whatsapp, rotulo, origem, created_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: true });
  const erro = errPrincipal ?? errExtras;
  if (erro) throw new ApiError(500, "internal_error", undefined, requestId, erro.message);
  return {
    phone_type: principal?.phone_type ?? null,
    phone_whatsapp: principal?.phone_whatsapp ?? null,
    additional_phones: (extras ?? []).map((e) => ({
      // O id é o endereço das rotas de editar, remover e tornar principal.
      id: e.id,
      phone_number: e.phone_number,
      type: e.tipo,
      whatsapp: e.whatsapp,
      label: e.rotulo,
      origin: e.origem,
      created_at: e.created_at,
    })),
  };
}

/**
 * LER A FICHA POR TOKEN (`Bearer dsk_…` com `mcp:read`, papel `viewer`).
 *
 * É a mesma ficha da sessão, pelo mesmo `getContactHandler` — com o client de
 * serviço, que ignora a RLS: a organização vem da linha do token e o handler a
 * repete em toda consulta, então id de outra organização é 404. O CPF nunca sai
 * em claro: o handler só o decifra para `actor.type === "user"`, e o cabeçalho
 * `X-Decrypt-Purpose` é ignorado aqui (a ficha diz só `cpf_available`).
 */
async function lerPorToken(
  req: NextRequest,
  requestId: string,
  id: string,
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;

  try {
    const result = await getContactHandler(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      { contactId: id, decryptPurpose: null },
    );
    const telefones = await telefonesDaFicha(authz.supabase, authz.organizationId, id, requestId);
    return ok({ ...result, ...telefones }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, "GET /api/v1/contacts/{id}");
    throw err;
  }
}

/**
 * EDITAR A FICHA POR TOKEN (`Bearer dsk_…` com `mcp:write`, papel `agent`).
 *
 * O mesmo patch da tela, pelo mesmo `patchContactHandler`, com a régua de
 * documento do PAÍS da organização do token. O handler não decide nada pelo
 * papel nem pelo usuário (não há "só os seus" nem conversa do criador no PATCH),
 * e a auditoria já grava o ator pelo tipo: `actor_type: "api_token"` + id do token.
 * Telefone, e-mail ou CPF de outro contato volta 409 `contact_exists` com o id
 * de quem já o tem em `details`.
 */
async function editarPorToken(
  req: NextRequest,
  requestId: string,
  id: string,
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (tetoEstourado) return tetoEstourado;

  const perfil = await perfilDaOrganizacao(authz.supabase, authz.organizationId);
  let input;
  try {
    input = await validateRequest(contactPatchSchemaDoPais(perfil), req);
  } catch (err) {
    if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, "PATCH /api/v1/contacts/{id}");
    throw err;
  }

  try {
    const contact = await patchContactHandler(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      id,
      input,
    );
    return ok(contact, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, "PATCH /api/v1/contacts/{id}");
    throw err;
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (extractBearer(req.headers.get("authorization"))) {
    // Id que não é UUID nunca existe: 404 limpo em vez do 500 do cast do banco.
    if (!UUID.test(id)) return fail("not_found", "Contato não encontrado.", 404, { requestId });
    return lerPorToken(req, requestId, id);
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  const decryptPurpose = req.headers.get("x-decrypt-purpose");

  try {
    const result = await getContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: authUser?.idioma,
      },
      { contactId: id, decryptPurpose },
    );
    const telefones = await telefonesDaFicha(supabase, activeOrg.orgId, id, requestId);
    return ok({ ...result, ...telefones }, { requestId });
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
  const { id } = await ctx.params;
  if (extractBearer(req.headers.get("authorization"))) {
    if (!UUID.test(id)) return fail("not_found", "Contato não encontrado.", 404, { requestId });
    return editarPorToken(req, requestId, id);
  }

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  // O documento do titular é validado pela régua do PAÍS da organização (issue
  // #1033) — a mesma razão do POST: quem decide é a organização, não o corpo.
  const perfil = await perfilDaOrganizacao(supabase, activeOrg.orgId);

  let input;
  try {
    input = await validateRequest(contactPatchSchemaDoPais(perfil), req);
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
    const contact = await patchContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      id,
      input,
    );
    return ok(contact, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  // Excluir ficha (e todo o histórico dela) é decisão de pessoa, com o fluxo de
  // LGPD próprio: não entra por token. Como o proxy libera o CAMINHO e não o
  // método, a recusa mora aqui — antes de qualquer efeito.
  if (extractBearer(req.headers.get("authorization"))) {
    return fail(
      "forbidden",
      "Excluir contato não é permitido por token. Use a tela, ou o fluxo de LGPD para anonimizar.",
      403,
      { requestId },
    );
  }

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  const supabase = await createClient();

  try {
    await deleteContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      id,
    );
    return noContent(requestId);
  } catch (err) {
    if (err instanceof ApiError) {
      // `details` carrega os vínculos que barraram a exclusão (#1925); sem ele a
      // tela só tem o texto genérico.
      return fail(err.code, err.message, err.status, { details: err.details, requestId });
    }
    throw err;
  }
}
