import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/automation-rules/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/automation-rules/[id] — remove a regra.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { extractBearer } from "@/lib/mcp/auth";
import { requireRole } from "@/lib/auth/require-role";
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { updateAutomationRuleSchema } from "@/lib/schemas";
import { acoesQueFechamLaco, MENSAGEM_DO_LACO_DE_LEAD } from "@/lib/schemas/webhooks";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";

import {
  PAPEL_DO_TOKEN,
  falhaInterna,
  recusaDeAgenteDeIa,
  recusaDeUrl,
  regraParaToken,
  semCifraDeFora,
} from "../_por-token";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (extractBearer(req.headers.get("authorization"))) return editarPorToken(req, requestId, id);
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
  const parsed = updateAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id, trigger_event, trigger_config, actions")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Regra não encontrada."), 404, { requestId });

  // O PATCH parcial (só o gatilho, ou só as ações) monta o laço de #1528 pela
  // porta do lado: o schema só o vê quando os dois vêm juntos. Desligar a regra
  // (só `is_active`) nunca é barrado.
  const gravada = existing as { trigger_event: string; actions: { type: string }[] | null };
  if (
    (parsed.data.trigger_event !== undefined || parsed.data.actions !== undefined) &&
    acoesQueFechamLaco(
      parsed.data.trigger_event ?? gravada.trigger_event,
      parsed.data.actions ?? gravada.actions ?? [],
    ).length
  ) {
    return fail("invalid_request", t(MENSAGEM_DO_LACO_DE_LEAD), 400, { requestId });
  }

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

  // Gatilho por data num campo do contato (#2791) nunca dispara: a regra que
  // chega assim — pela API, ou antiga sendo regravada ou religada — é recusada.
  // Desligar e renomear não passam por aqui.
  if (
    parsed.data.trigger_event !== undefined ||
    parsed.data.trigger_config !== undefined ||
    parsed.data.is_active === true
  ) {
    const campoDeData = await campoDoGatilhoDeDataEhDoContato(
      supabase,
      activeOrg.orgId,
      parsed.data.trigger_event ?? gravada.trigger_event,
      parsed.data.trigger_config ?? (existing as { trigger_config: unknown }).trigger_config,
    );
    if ("erro" in campoDeData) return fail("internal_error", campoDeData.erro, 500, { requestId });
    if (campoDeData.doContato) {
      return fail("invalid_request", t(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO), 422, { requestId });
    }
  }

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041);
  // secret_enc existente (round-trip do editor) passa intacto.
  // A autoria vai junto de TODA escrita, pelo mesmo helper que o agente usa: uma
  // regra ligada é o estado mais perigoso do sistema, e a tela precisa dizer
  // quem a ligou (migration 0101).
  const patch: Record<string, unknown> = {
    ...parsed.data,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca({ type: "user", id: user.id, role: activeOrg.role }),
  };
  if (parsed.data.actions !== undefined) {
    const safeActions = await encryptRuleActionSecrets(createAdminClient(), parsed.data.actions);
    if (safeActions === null) {
      return fail(
        "encryption_unavailable",
        t("Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave."),
        422,
        { requestId },
      );
    }
    patch.actions = safeActions;
  }

  const { data: updated, error: updErr } = await supabase
    .from("automation_rules")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  const { actions: _actionsWithSecrets, ...auditableRule } = parsed.data;
  void audit({
    action: "automation.rule_updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
    // actions fora do audit: config de call_webhook carrega secret plaintext no input.
    metadata: { ...auditableRule, ...(parsed.data.actions !== undefined ? { actions_changed: true } : {}) },
  });

  return ok(updated, { requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (extractBearer(req.headers.get("authorization"))) return apagarPorToken(req, requestId, id);
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Regra não encontrada."), 404, { requestId });

  const { error: delErr } = await supabase.from("automation_rules").delete().eq("id", id);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "automation.rule_deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * EDITAR / ATIVAR / DESATIVAR POR TOKEN (`mcp:write`, papel `admin`). O mesmo
 * PATCH da tela, pelo client de serviço: toda leitura e a escrita filtram a
 * organização da LINHA DO TOKEN, e id de outra organização é 404 (nunca o dado).
 * O segredo não volta, e trocar `actions` exige reenviar o `secret` — o cliente
 * nunca viu o que estava guardado, então o que ele não mandar não é preservado.
 */
async function editarPorToken(req: NextRequest, requestId: string, id: string): Promise<Response> {
  const rota = "PATCH /api/v1/automation-rules/{id}";
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    tokenRole: PAPEL_DO_TOKEN,
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const ia = recusaDeAgenteDeIa(authz, requestId);
  if (ia) return ia;
  if (!UUID.test(id)) return fail("not_found", "Regra não encontrada.", 404, { requestId });

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "automation_rules", requestId);
  if (tetoEstourado) return tetoEstourado;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, { requestId, details: parsed.error.flatten() });
  }
  const dados = {
    ...parsed.data,
    ...(parsed.data.actions !== undefined ? { actions: semCifraDeFora(parsed.data.actions) } : {}),
  };
  if (dados.actions !== undefined) {
    const urlRecusada = recusaDeUrl(dados.actions, requestId);
    if (urlRecusada) return urlRecusada;
  }

  const { supabase, organizationId } = authz;
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id, trigger_event, trigger_config, actions")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (fetchErr) return falhaInterna(requestId, rota, fetchErr.message);
  if (!existing) return fail("not_found", "Regra não encontrada.", 404, { requestId });

  const gravada = existing as { trigger_event: string; actions: { type: string }[] | null };
  if (
    (dados.trigger_event !== undefined || dados.actions !== undefined) &&
    acoesQueFechamLaco(dados.trigger_event ?? gravada.trigger_event, dados.actions ?? gravada.actions ?? []).length
  ) {
    return fail("invalid_request", MENSAGEM_DO_LACO_DE_LEAD, 400, { requestId });
  }

  const webhookSourceId = dados.trigger_config?.webhook_source_id;
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

  if (dados.trigger_event !== undefined || dados.trigger_config !== undefined || dados.is_active === true) {
    const campoDeData = await campoDoGatilhoDeDataEhDoContato(
      supabase,
      organizationId,
      dados.trigger_event ?? gravada.trigger_event,
      dados.trigger_config ?? (existing as { trigger_config: unknown }).trigger_config,
    );
    if ("erro" in campoDeData) return falhaInterna(requestId, rota, campoDeData.erro);
    if (campoDeData.doContato) {
      return fail("invalid_request", MENSAGEM_CAMPO_DE_DATA_DO_CONTATO, 422, { requestId });
    }
  }

  const patch: Record<string, unknown> = {
    ...dados,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca(authz.actor),
  };
  if (dados.actions !== undefined) {
    const safeActions = await encryptRuleActionSecrets(createAdminClient(), dados.actions);
    if (safeActions === null) {
      return fail(
        "encryption_unavailable",
        "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh.",
        422,
        { requestId },
      );
    }
    patch.actions = safeActions;
  }

  const { data: updated, error: updErr } = await supabase
    .from("automation_rules")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (updErr || !updated) return falhaInterna(requestId, rota, updErr?.message ?? "automation_rule_update_failed");

  const { actions: _actionsWithSecrets, ...auditableRule } = dados;
  void audit({
    action: "automation.rule_updated",
    actorUserId: null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
    // actions fora do audit: a config de call_webhook carrega o segredo em claro no input.
    metadata: { ...auditableRule, via: "token", ...(dados.actions !== undefined ? { actions_changed: true } : {}) },
  });

  return ok(regraParaToken(updated), { requestId });
}

/** APAGAR POR TOKEN (`mcp:write`, papel `admin`). Id de outra organização é 404. */
async function apagarPorToken(req: NextRequest, requestId: string, id: string): Promise<Response> {
  const rota = "DELETE /api/v1/automation-rules/{id}";
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    tokenRole: PAPEL_DO_TOKEN,
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const ia = recusaDeAgenteDeIa(authz, requestId);
  if (ia) return ia;
  if (!UUID.test(id)) return fail("not_found", "Regra não encontrada.", 404, { requestId });

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "automation_rules", requestId);
  if (tetoEstourado) return tetoEstourado;

  const { supabase, organizationId } = authz;
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (fetchErr) return falhaInterna(requestId, rota, fetchErr.message);
  if (!existing) return fail("not_found", "Regra não encontrada.", 404, { requestId });

  const { error: delErr } = await supabase
    .from("automation_rules")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (delErr) return falhaInterna(requestId, rota, delErr.message);

  void audit({
    action: "automation.rule_deleted",
    actorUserId: null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
    metadata: { via: "token" },
  });

  return noContent(requestId);
}
