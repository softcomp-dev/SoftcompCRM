import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/contacts/[id]/atendimentos — o HISTÓRICO DE ATENDIMENTO do contato.
 *
 * GET  — toda interação da equipe com o cliente, mais recente primeiro: o chat
 *        (por conversa e dia), as ligações pelo CRM (VoIP e WhatsApp) e o que o
 *        vendedor registrou. Calculado das tabelas de origem a cada leitura;
 *        a montagem e a regra de paginação estão em `lib/atendimento/historico.ts`.
 * POST — o vendedor registra uma interação que aconteceu FORA do CRM (ligação do
 *        celular, reunião, visita, e-mail). Vira uma linha em
 *        `crm_lead_activities` no negócio escolhido; as regras estão em
 *        `lib/atendimento/interacao-manual.ts`.
 *
 * ── Não é a timeline ─────────────────────────────────────────────────────────
 * `contacts/[id]/timeline` conta TUDO que aconteceu com o contato (etapa mudou,
 * proposta enviada, follow-up agendado). Esta rota responde outra pergunta:
 * "quando e como alguém falou com este cliente?". Por isso lê também o chat,
 * que a timeline não tem, e deixa de fora o que não é conversa.
 *
 * Sessão de cookie; leitura para todo papel (a RLS de cada tabela decide o que
 * a pessoa enxerga), escrita a partir de `agent`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import {
  TIPOS_DE_REGISTRO,
  montarPagina,
  type AtividadeBruta,
  type ChamadaBruta,
  type HistoricoDeAtendimento,
  type ItemDoHistoricoView,
  type MensagemBruta,
} from "@/lib/atendimento/historico";
import {
  payloadDaInteracao,
  registrarInteracaoSchema,
  tipoDaInteracao,
} from "@/lib/atendimento/interacao-manual";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { fusoDaOrganizacao } from "@/lib/propostas/data-no-fuso";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Teto de mensagens por leitura. Largo de propósito: a página só leva dias
 * inteiros, e um dia com mais mensagens que isto chega contado pela metade
 * (`montarPagina`, último caso).
 */
const TETO_DE_MENSAGENS = 500;

const consultaSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().max(200).optional(),
});

/** O cursor é o instante "antes de", opaco para o cliente. */
function lerCursor(bruto: string): string | null {
  try {
    const { antes } = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as { antes?: unknown };
    return typeof antes === "string" && !Number.isNaN(Date.parse(antes)) ? antes : null;
  } catch {
    return null;
  }
}
function escreverCursor(antes: string): string {
  return Buffer.from(JSON.stringify({ antes }), "utf8").toString("base64url");
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const url = new URL(req.url);
  const consulta = consultaSchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  if (!consulta.success) return fail("validation_failed", t("Dados inválidos."), 400, { requestId });
  const { limit } = consulta.data;
  let antes: string | null = null;
  if (consulta.data.cursor) {
    antes = lerCursor(consulta.data.cursor);
    if (!antes) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
  }

  if (!UUID.test(contactId)) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  const supabase = await createClient();
  const { data: contato, error: erroContato } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroContato) return fail("internal_error", erroContato.message, 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  const [conversas, negocios] = await Promise.all([
    supabase.from("conversations").select("id").eq("organization_id", orgId).eq("contact_id", contactId),
    supabase
      .from("crm_leads")
      .select("id, title, status, last_activity_at, created_at, crm_pipelines(name)")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false }),
  ]);
  if (conversas.error) return fail("internal_error", conversas.error.message, 500, { requestId });
  if (negocios.error) return fail("internal_error", negocios.error.message, 500, { requestId });

  const idsDeConversa = (conversas.data ?? []).map((c) => (c as { id: string }).id);
  const idsDeNegocio = (negocios.data ?? []).map((l) => (l as { id: string }).id);
  const tetoDasOutras = limit + 1;

  const vazio = Promise.resolve({ data: [] as never[], error: null });
  const [mensagens, chamadas, registros, fuso] = await Promise.all([
    idsDeConversa.length === 0
      ? vazio
      : (() => {
          let q = supabase
            .from("messages")
            .select("id, conversation_id, direction, sent_via, sent_by_user_id, type, status, sent_at")
            .eq("organization_id", orgId)
            .eq("contact_id", contactId)
            .in("conversation_id", idsDeConversa)
            .order("sent_at", { ascending: false })
            .limit(TETO_DE_MENSAGENS);
          if (antes) q = q.lt("sent_at", antes);
          return q;
        })(),
    (() => {
      let q = supabase
        .from("voice_calls")
        .select(
          "id, provider, direction, status, started_at, answered_at, ended_at, duration_ms, owner_user_id, created_by, handled_by, lead_id",
        )
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .order("started_at", { ascending: false })
        .limit(tetoDasOutras);
      if (antes) q = q.lt("started_at", antes);
      return q;
    })(),
    idsDeNegocio.length === 0
      ? vazio
      : (() => {
          let q = supabase
            .from("crm_lead_activities")
            .select("id, type, lead_id, performed_at, performed_by_user_id, reason, payload")
            .eq("organization_id", orgId)
            .in("lead_id", idsDeNegocio)
            .in("type", [...TIPOS_DE_REGISTRO])
            .order("performed_at", { ascending: false })
            .limit(tetoDasOutras);
          if (antes) q = q.lt("performed_at", antes);
          return q;
        })(),
    fusoDaOrganizacao(supabase, orgId),
  ]);
  for (const r of [mensagens, chamadas, registros]) {
    if (r.error) {
      logger.error("contacts.atendimentos: leitura falhou", { requestId, erro: r.error.message });
      return fail("internal_error", t("Não foi possível carregar o histórico de atendimento."), 500, { requestId });
    }
  }

  const linhasDeMensagem = (mensagens.data ?? []) as MensagemBruta[];
  const linhasDeChamada = (chamadas.data ?? []) as ChamadaBruta[];
  const linhasDeRegistro = (registros.data ?? []) as AtividadeBruta[];

  const pagina = montarPagina({
    fuso,
    limite: limit,
    mensagens: { linhas: linhasDeMensagem, noTeto: linhasDeMensagem.length >= TETO_DE_MENSAGENS },
    chamadas: { linhas: linhasDeChamada, noTeto: linhasDeChamada.length >= tetoDasOutras },
    registros: { linhas: linhasDeRegistro, noTeto: linhasDeRegistro.length >= tetoDasOutras },
  });

  // Quem participou, com NOME — resolvido aqui, como na timeline (`comNomeDoAtor`).
  const { nomesDosAtendentes } = await import("@/lib/users/nome-do-atendente");
  const nomes = await nomesDosAtendentes(
    orgId,
    pagina.itens.flatMap((i) => i.team_user_ids),
  );
  const items: ItemDoHistoricoView[] = pagina.itens.map(({ team_user_ids, ...resto }) => ({
    ...resto,
    team: team_user_ids.map((id) => ({ user_id: id, name: nomes.get(id) ?? null })),
  }));

  const corpo: HistoricoDeAtendimento = { items };
  if (!antes) {
    corpo.leads = (negocios.data ?? []).map((l) => {
      const linha = l as {
        id: string;
        title: string;
        status: string;
        last_activity_at: string | null;
        created_at: string;
        crm_pipelines: { name: string } | { name: string }[] | null;
      };
      const funil = Array.isArray(linha.crm_pipelines) ? linha.crm_pipelines[0] : linha.crm_pipelines;
      return {
        id: linha.id,
        title: linha.title,
        status: linha.status,
        pipeline_name: funil?.name ?? null,
        last_activity_at: linha.last_activity_at,
        created_at: linha.created_at,
      };
    });
  }

  return ok(corpo, {
    requestId,
    meta: {
      cursor: pagina.proximoAntes ? escreverCursor(pagina.proximoAntes) : null,
      has_more: pagina.proximoAntes !== null,
    },
  });
}

/** A interação registrada como a resposta (e o recibo de idempotência) a devolve. */
interface InteracaoRegistrada extends Record<string, unknown> {
  id: string;
  lead_id: string;
  type: string;
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
  const { id: contactId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !UUID.test(chave)) {
    return fail("validation_failed", "Idempotency-Key deve ser um UUID.", 400, { requestId });
  }

  const parsed = registrarInteracaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;

  if (!UUID.test(contactId)) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  const supabase = await createClient();
  const { data: contato, error: erroContato } = await supabase
    .from("contacts")
    .select("id, is_anonymized")
    .eq("id", contactId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroContato) return fail("internal_error", erroContato.message, 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  if ((contato as { is_anonymized?: boolean }).is_anonymized) {
    // Registrar texto livre sobre quem exerceu o direito de apagamento recriaria
    // o dado que a anonimização acabou de apagar.
    return fail("conflict", t("Este contato foi anonimizado e não recebe novos registros."), 409, { requestId });
  }

  // O negócio tem de ser DESTE contato e desta organização. Negócio de outro
  // contato é 422 e não 404: o id existe, só não pertence a esta ficha.
  const { data: lead, error: erroLead } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", input.lead_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroLead) return fail("internal_error", erroLead.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  if ((lead as { contact_id: string | null }).contact_id !== contactId) {
    return fail("unprocessable_entity", t("Este negócio não é deste contato."), 422, { requestId });
  }

  const tipo = tipoDaInteracao(input.outcome);

  const registrar = async (): Promise<{ resposta: InteracaoRegistrada; status: number }> => {
    const linha = buildLeadActivityRow({
      organizationId: orgId,
      leadId: input.lead_id,
      contactId,
      type: tipo,
      sourceModule: "atendimento",
      actor: { type: "user", id: userId },
      reason: input.summary,
      payload: payloadDaInteracao(input),
    });
    const { data, error } = await supabase
      .from("crm_lead_activities")
      .insert({ ...linha, ...(input.occurred_at ? { performed_at: input.occurred_at } : {}) })
      .select("id, performed_at, created_at")
      .single();
    if (error || !data) {
      logger.error("contacts.atendimentos: gravação falhou", { requestId, erro: error?.message });
      throw new Error("interacao_nao_gravada");
    }
    const row = data as { id: string; performed_at: string; created_at: string };

    await audit({
      action: "lead.updated",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "crm_lead",
      resourceId: input.lead_id,
      requestId,
      // A forma do contato, nunca o texto: o resumo é dado pessoal e mora só na atividade.
      metadata: {
        mudanca: "interacao_registrada",
        activity_id: row.id,
        canal: input.channel,
        desfecho: input.outcome,
      },
    });

    return {
      resposta: {
        id: row.id,
        lead_id: input.lead_id,
        type: tipo,
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
        : await comIdempotencia<InteracaoRegistrada>({
            // O recibo mora numa tabela que a sessão não escreve; o helper filtra
            // por organização em toda consulta.
            db: createAdminClient(),
            organizationId: orgId,
            endpoint: `POST /api/v1/contacts/${contactId}/atendimentos`,
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
    return fail("internal_error", t("Não foi possível registrar a interação."), 500, { requestId });
  }
}
