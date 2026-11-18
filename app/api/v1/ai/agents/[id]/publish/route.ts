import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/agents/:id/publish  body: { version_id }
 *
 * Atomic flip via fn_publish_ai_agent_version (Spec 10 §4.5):
 *   - prev published version → 'superseded'
 *   - target version → 'published'
 *   - ai_agents.published_version_id → target
 * Validates credential, channel_session, model and tool_ids before commit.
 *
 * Maps validation errors to 422 with stable codes (PublishErrorCode).
 * Emits event_log 'ai_agent.published' fire-and-forget after commit.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishSchema, PUBLISH_ERROR_CODES, type PublishErrorCode } from "@/lib/ai/agents/validation";
import { toolIdAceito } from "@/lib/mcp/servidor-externo/ids";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools";
import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { traduzir } from "@/lib/i18n/dicionario";

const VALID_TOOL_IDS_RUNTIME = new Set<string>(VALID_TOOL_IDS as readonly string[]);

/** Catálogo compilado + ferramenta remota escolhida (item 6) — ver `toolIdAceito`. */
const toolIdValido = (t: string) => toolIdAceito(t, VALID_TOOL_IDS_RUNTIME);

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

/**
 * O que dizer a quem tentou publicar, por motivo. O código vai junto; o texto
 * é o que um integrador lê para saber o que corrigir — antes era um
 * "Validação de publish falhou." igual para todos os motivos. `Record`
 * exaustivo: código novo sem texto não compila. Cada `t()` recebe a frase
 * literal, para a cerca de tradução enxergá-la.
 */
function motivoDaRecusa(t: (texto: string) => string): Record<PublishErrorCode, string> {
  return {
    agent_not_found: t("Agente não encontrado nesta organização."),
    agent_archived: t("O agente está arquivado. Desarquive-o antes de publicar."),
    version_not_found: t("Versão não encontrada nesta organização."),
    existing_version_requires_review: t("Este agente já tem outras versões. Revise e publique pela tela do agente."),
    version_invalid_state: t("Só uma versão em rascunho (ou substituída) pode ser publicada."),
    credential_missing: t(
      "A versão usa a chave da instalação, e esta instalação não tem chave desse provedor. Informe credential_id com uma credencial cadastrada.",
    ),
    credential_not_found: t("A credencial da versão não existe nesta organização."),
    credential_inactive: t("A credencial da versão está desativada."),
    credential_not_validated: t("A credencial da versão ainda não foi validada. Teste-a em IA › Credenciais."),
    credential_provider_mismatch: t("A credencial da versão é de outro provedor de IA."),
    channel_session_not_found: t(
      "A versão não tem canal. Informe channel_session_id com um canal desta organização, ou ponha o agente num roteador.",
    ),
    channel_session_offline: t("O canal da versão não está conectado. Conecte-o em Conexões antes de publicar."),
    model_not_found: t("O modelo da versão não existe para esse provedor."),
    tool_id_invalid: t("tool_ids contém ids inexistentes no catálogo MCP."),
  };
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_agents",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId, actor } = authz;

  const teto = await tetoDeEscritaDoToken(authz, "ai_agents_publish", requestId);
  if (teto) return teto;
  const authUserId = actor.type === "user" ? actor.id : null;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = publishSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  // Pre-flight: tool_ids do target version são válidos no catálogo MCP atual?
  // (catálogo evolui — validar à hora do publish, fora da transação SQL.)
  const { data: targetV } = await admin
    .from("ai_agent_versions")
    .select("id, agent_id, organization_id, tool_ids, status")
    .eq("id", parsed.data.version_id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!targetV || targetV.agent_id !== id) {
    return fail("version_not_found", t("Version não encontrada."), 404, { requestId });
  }

  const tools = (targetV.tool_ids ?? []) as string[];
  const invalid = tools.filter((t) => !toolIdValido(t));
  if (invalid.length > 0) {
    return fail("tool_id_invalid", t("tool_ids contém ids inexistentes no catálogo MCP."), 422, {
      requestId,
      details: { invalid },
    });
  }

  const result = await publishAgentVersion(admin, {
    orgId: organizationId,
    agentId: id,
    versionId: parsed.data.version_id,
    // #2156: com quem/publicação a chave por assunto jurídico muda vira
    // `ai_agent.legal_handoff_changed` com ator e requestId preenchidos.
    quemPublicou: { actorUserId: authUserId, actorApiTokenId: authz.apiTokenId ?? null, requestId },
  });

  if (!result.ok) {
    if (PUBLISH_ERROR_CODES.has(result.code as string)) {
      const status = result.code === "agent_not_found" || result.code === "version_not_found"
        ? 404
        : 422;
      const motivo = motivoDaRecusa(t)[result.code as PublishErrorCode];
      return fail(result.code, motivo, status, { requestId });
    }
    return fail("internal_error", "Erro ao publicar.", 500, { requestId });
  }

  // event_log + audit fire-and-forget.
  void admin
    .from("event_log")
    .insert({
      organization_id: organizationId,
      event_type: "ai_agent.published",
      // NOT NULL sem default — ver `tests/unit/evento-de-publicacao-tem-dono.test.ts`.
      entity_kind: "ai_agent",
      payload: {
        agent_id: result.agent_id,
        version_id: result.version_id,
        previous_version_id: result.previous_version_id,
        published_at: result.published_at,
      },
    })
    .then(({ error }) => {
      if (error) console.error("[ai_agents/publish] event_log error", error.message);
    });

  void audit({
    action: "ai_agent.published",
    actorUserId: authUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: organizationId,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: {
      version_id: result.version_id,
      previous_version_id: result.previous_version_id,
    },
  });

  return ok(
    {
      agent_id: result.agent_id,
      version_id: result.version_id,
      previous_version_id: result.previous_version_id,
      published_at: result.published_at,
    },
    { requestId },
  );
}
