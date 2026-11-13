import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/notes
 *
 * Registra uma NOTA na linha do tempo do negócio (`crm_lead_activities`). Existe
 * para o ERP deixar fato legível ao vendedor ("NF 1234 emitida", "boleto
 * vencido") sem inventar tela: a nota aparece no dossiê do negócio junto do
 * resto da vida dele.
 *
 * Dual: sessão (agent+) ou `Bearer dsk_…` com `mcp:write` (papel agent).
 *
 * ── Por que NÃO reaproveita as notas do Inbox ────────────────────────────────
 * `POST /api/v1/conversations/[id]/notes` grava a nota INTERNA DA CONVERSA (outra
 * tabela, outro substantivo: aparece no chat, não na linha do tempo do negócio).
 * A linha do tempo do negócio só recebia atividade escrita pelo sistema; esta é
 * a primeira porta para texto livre dele. O tipo é o `note` do vocabulário
 * fechado (`ActivityType`), o mesmo que o webhook de captação já emite — nunca
 * string solta.
 *
 * ── Onde o texto mora ────────────────────────────────────────────────────────
 * Em `reason`, que é a coluna que a timeline lê e que a anonimização (LGPD) já
 * apaga. Num `payload` ele sobreviveria ao redact.
 *
 * ── Autoria ──────────────────────────────────────────────────────────────────
 * Sessão: o usuário. Token: `actor_kind = system` (não há pessoa nem agente), e
 * o `payload.via` + `api_token_id` dizem que foi integração e qual token.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { TIPO_DA_NOTA, notaDoNegocioSchema } from "./schema";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A nota como a resposta (e o recibo de idempotência) a devolve. */
interface NotaRegistrada extends Record<string, unknown> {
  id: string;
  lead_id: string;
  type: typeof TIPO_DA_NOTA;
  body: string;
  occurred_at: string;
  created_at: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !UUID.test(chave)) {
    return fail("validation_failed", "Idempotency-Key deve ser um UUID.", 400, { requestId });
  }

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "leads", requestId);
  if (tetoEstourado) return tetoEstourado;

  const bruto = await req.json().catch(() => null);
  const parsed = notaDoNegocioSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;

  if (!UUID.test(leadId)) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  // `organization_id` à mão: com token o client ignora a RLS, e com sessão ele
  // continua sendo a regra da casa. Lead de outra organização é 404.
  const { data: lead, error: leadErr } = await authz.supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (leadErr) {
    logger.error("leads.notes: leitura do negócio falhou", { requestId, erro: leadErr.message });
    return fail("internal_error", t("Erro ao salvar a nota."), 500, { requestId });
  }
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const registrar = async (): Promise<{ resposta: NotaRegistrada; status: number }> => {
    const linha = buildLeadActivityRow({
      organizationId: authz.organizationId,
      leadId,
      contactId: (lead as { contact_id?: string | null }).contact_id ?? null,
      type: TIPO_DA_NOTA,
      sourceModule: "api",
      actor: authz.actor,
      reason: input.body,
      payload: {
        via: authz.via,
        ...(authz.apiTokenId ? { api_token_id: authz.apiTokenId } : {}),
        request_id: requestId,
      },
    });
    const { data, error } = await authz.supabase
      .from("crm_lead_activities")
      .insert({ ...linha, ...(input.occurred_at ? { performed_at: input.occurred_at } : {}) })
      .select("id, performed_at, created_at")
      .single();
    if (error || !data) {
      logger.error("leads.notes: gravação da nota falhou", { requestId, erro: error?.message });
      throw new Error("nota_nao_gravada");
    }
    const row = data as { id: string; performed_at: string; created_at: string };

    await audit({
      action: "lead.updated",
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: authz.organizationId,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: { mudanca: "nota_registrada", activity_id: row.id, via: authz.via },
    });

    return {
      resposta: {
        id: row.id,
        lead_id: leadId,
        type: TIPO_DA_NOTA,
        body: input.body,
        occurred_at: row.performed_at,
        created_at: row.created_at,
      },
      status: 201,
    };
  };

  try {
    const desfecho =
      chave === null
        ? { tipo: "executou" as const, ...(await registrar()) }
        : await comIdempotencia<NotaRegistrada>({
            // O recibo mora numa tabela que a sessão não escreve: o client de
            // serviço entra, e o helper filtra por organização em toda consulta.
            db: createAdminClient(),
            organizationId: authz.organizationId,
            endpoint: `POST /api/v1/leads/${leadId}/notes`,
            chave,
            corpo: input,
            executar: registrar,
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
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch {
    return fail("internal_error", t("Erro ao salvar a nota."), 500, { requestId });
  }
}
