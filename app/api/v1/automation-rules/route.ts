import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/automation-rules — lista as regras de automação da org ativa.
 * POST /api/v1/automation-rules — cria uma regra. is_active NUNCA aceito no
 *   create (schema não tem o campo) — regra nasce pausada (default FALSE do banco).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { falhaDoHandlerParaToken } from "@/lib/api/integracao-por-token";
import { ApiError } from "@/lib/api/types";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { extractBearer } from "@/lib/mcp/auth";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { requireRole } from "@/lib/auth/require-role";
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import { createAutomationRuleSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";

import {
  PAPEL_DO_TOKEN,
  chaveInvalida,
  falhaInterna,
  recusaDeAgenteDeIa,
  recusaDeUrl,
  regraParaToken,
  semCifraDeFora,
} from "./_por-token";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Bearer `dsk_…` (ERP): lê as regras sem entrar na tela. O segredo não volta.
  if (extractBearer(req.headers.get("authorization"))) return listarPorToken(req, requestId);
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  if (extractBearer(req.headers.get("authorization"))) return criarPorToken(req, requestId);
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041).
  const safeActions = await encryptRuleActionSecrets(createAdminClient(), parsed.data.actions);
  if (safeActions === null) {
    return fail(
      "encryption_unavailable",
      t("Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a ação sem segredo."),
      422,
      { requestId },
    );
  }

  const supabase = await createClient();
  const webhookSourceId = parsed.data.trigger_config?.webhook_source_id;
  if (typeof webhookSourceId === "string") {
    const { data: source, error: sourceError } = await supabase
      .from("webhook_sources")
      .select("id")
      .eq("id", webhookSourceId)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (sourceError) return fail("internal_error", sourceError.message, 500, { requestId });
    if (!source) {
      return fail("invalid_request", t("A fonte escolhida não pertence a esta empresa."), 422, { requestId });
    }
  }
  const campoDeData = await campoDoGatilhoDeDataEhDoContato(
    supabase,
    activeOrg.orgId,
    parsed.data.trigger_event,
    parsed.data.trigger_config,
  );
  if ("erro" in campoDeData) return fail("internal_error", campoDeData.erro, 500, { requestId });
  if (campoDeData.doContato) {
    return fail("invalid_request", t(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO), 422, { requestId });
  }
  const { data: created, error: insErr } = await supabase
    .from("automation_rules")
    .insert({
      organization_id: activeOrg.orgId,
      created_by_user_id: user.id,
      name: parsed.data.name,
      trigger_event: parsed.data.trigger_event,
      conditions: parsed.data.conditions,
      actions: safeActions,
      // O gatilho de data do funil (#989) precisa que a regra guarde o funil, o
      // campo e o N assinado — sem isso a varredura não sabe onde olhar. Os
      // outros gatilhos gravam o objeto vazio do default.
      trigger_config: parsed.data.trigger_config ?? {},
    })
    .select("*")
    .single();
  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "automation_rule_insert_failed", 500, { requestId });
  }

  void audit({
    action: "automation.rule_created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: created.id,
    requestId,
    metadata: { name: parsed.data.name, trigger_event: parsed.data.trigger_event },
  });

  return ok(created, { requestId, status: 201 });
}

/**
 * LISTAR POR TOKEN (`mcp:read`, papel `admin`). Mesma lista da tela, pelo client
 * de serviço — por isso o filtro de organização é este, o da linha do token. O
 * segredo do webhook nunca volta: `secret_enc` sai e `secret_configured` fica.
 */
async function listarPorToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    tokenRole: PAPEL_DO_TOKEN,
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;

  const { data, error } = await authz.supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: false });
  if (error) return falhaInterna(requestId, "GET /api/v1/automation-rules", error.message);
  return ok((data ?? []).map(regraParaToken), { requestId });
}

/**
 * CRIAR REGRA POR TOKEN (`mcp:write`, papel `admin`): o ERP configura "quando X,
 * chamar webhook" sem entrar em cada CRM. Faz o que a tela faz — mesmo schema,
 * mesma cifra do segredo, mesmas conferências — com três diferenças: a URL é
 * conferida já na escrita, `Idempotency-Key` é aceita, e o `created_by_user_id`
 * fica vazio (o criador é o token, que consta na auditoria). A regra nasce
 * PAUSADA; ligar é um PATCH `is_active` à parte.
 */
async function criarPorToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    tokenRole: PAPEL_DO_TOKEN,
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const rota = "POST /api/v1/automation-rules";

  const ia = recusaDeAgenteDeIa(authz, requestId);
  if (ia) return ia;

  const chave = chaveDaRequisicao(req);
  if (chaveInvalida(chave)) {
    return fail("validation_failed", "Idempotency-Key deve ser um UUID.", 400, { requestId });
  }

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "automation_rules", requestId);
  if (tetoEstourado) return tetoEstourado;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, { requestId, details: parsed.error.flatten() });
  }
  const entrada = { ...parsed.data, actions: semCifraDeFora(parsed.data.actions) };

  const urlRecusada = recusaDeUrl(entrada.actions, requestId);
  if (urlRecusada) return urlRecusada;

  const { supabase, organizationId } = authz;

  const webhookSourceId = entrada.trigger_config?.webhook_source_id;
  if (typeof webhookSourceId === "string") {
    const { data: source, error: sourceError } = await supabase
      .from("webhook_sources")
      .select("id")
      .eq("id", webhookSourceId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (sourceError) return falhaInterna(requestId, rota, sourceError.message);
    if (!source) return fail("invalid_request", "A fonte escolhida não pertence a esta empresa.", 422, { requestId });
  }
  const campoDeData = await campoDoGatilhoDeDataEhDoContato(
    supabase,
    organizationId,
    entrada.trigger_event,
    entrada.trigger_config,
  );
  if ("erro" in campoDeData) return falhaInterna(requestId, rota, campoDeData.erro);
  if (campoDeData.doContato) {
    return fail("invalid_request", MENSAGEM_CAMPO_DE_DATA_DO_CONTATO, 422, { requestId });
  }

  const criar = async () => {
    // O segredo é cifrado DENTRO do que roda uma vez: com a chave repetida, o
    // segundo pedido devolve o recibo e não gasta uma cifra nem cria a segunda regra.
    const safeActions = await encryptRuleActionSecrets(createAdminClient(), entrada.actions);
    if (safeActions === null) {
      throw new ApiError(
        422,
        "encryption_unavailable",
        undefined,
        requestId,
        "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh. Enquanto isso, crie a ação sem segredo.",
      );
    }
    const { data: created, error: insErr } = await supabase
      .from("automation_rules")
      .insert({
        organization_id: organizationId,
        created_by_user_id: null,
        name: entrada.name,
        trigger_event: entrada.trigger_event,
        conditions: entrada.conditions,
        actions: safeActions,
        trigger_config: entrada.trigger_config ?? {},
        ...autoriaDaMudanca(authz.actor),
      })
      .select("*")
      .single();
    if (insErr || !created) {
      throw new ApiError(500, "internal_error", undefined, requestId, insErr?.message ?? "automation_rule_insert_failed");
    }

    void audit({
      action: "automation.rule_created",
      actorUserId: null,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId,
      resourceType: "automation_rule",
      resourceId: created.id,
      requestId,
      metadata: { name: entrada.name, trigger_event: entrada.trigger_event, via: "token" },
    });
    return { resposta: regraParaToken(created), status: 201 };
  };

  try {
    const desfecho =
      chave === null
        ? ({ tipo: "executou", ...(await criar()) } as const)
        : await comIdempotencia({
            db: supabase,
            organizationId,
            endpoint: rota,
            chave,
            corpo: raw,
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
    if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, rota);
    throw err;
  }
}
