import { requireSupportWrite } from "@/lib/impersonate/support";
import { carteiraDoContato } from "@/lib/carteira/dono";
import { MOTIVO_DA_RECUSA, recusaNegocioNaCarteiraDeOutro } from "@/lib/carteira/negocio-novo";
import { traduzir } from "@/lib/i18n/dicionario";
/**
 * GET  /api/v1/leads — lista negócios (sessão ou token `mcp:read`), em ordem
 *      estável (updated_at, id) para sincronização incremental.
 * POST /api/v1/leads — create lead (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import { falhaDoHandlerParaToken, recusaDaEtapaParaToken } from "@/lib/api/integracao-por-token";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { extractBearer } from "@/lib/mcp/auth";
import { somenteOProprio, type VisibilityMode } from "@/lib/auth/types";
import {
  AVISO_NEGOCIO_ABERTO_EXISTENTE,
  negocioAbertoExistente,
} from "@/lib/leads/negocio-aberto-duplicado";
import {
  createLeadPorTokenSchema,
  createLeadSchema,
  listLeadsQuerySchema,
  validateRequest,
  type CreateLeadInput,
  type CreateLeadPorTokenInput,
} from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

import { createLeadHandler, leadDaOrigemExterna, leadJaExiste } from "./_handler";
import { enriquecerNegocios, listarNegociosPorAtualizacao, resolverAuthDeLeitura } from "./_leitura";

export const dynamic = "force-dynamic";

/**
 * LISTAR NEGÓCIOS (viewer+, sessão ou `Bearer dsk_…` com `mcp:read`).
 *
 * Filtros: pipeline_id, stage_id, status, owner_user_id, source, external_id e
 * updated_since. Ordem fixa por (updated_at, id) ascendente, cursor opaco
 * (400 `invalid_cursor` se adulterado). Com sessão a RLS decide o que se vê
 * (inclusive o "só os seus"); com token a organização é a da linha do token.
 * Negócio de contato pessoal e a prova interna de meta ficam de fora, como no
 * quadro e na tool MCP `crm_list_leads`.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolverAuthDeLeitura(req, requestId);
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  const params = new URL(req.url).searchParams;
  const parsed = listLeadsQuerySchema.safeParse(Object.fromEntries(params.entries()));
  if (!parsed.success) {
    return fail("validation_failed", traduzir("Query inválida.", idioma ?? "pt-BR"), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const lista = await listarNegociosPorAtualizacao(
      supabase,
      { organization_id: organizationId, actor, requestId, idioma },
      parsed.data,
    );
    const leads = await enriquecerNegocios(supabase, organizationId, lista.leads);
    return ok(leads, { requestId, meta: { cursor: lista.cursor, has_more: lista.has_more } });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  if (extractBearer(req.headers.get("authorization"))) {
    return criarPorToken(req, requestId);
  }

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // ─── NO "SÓ OS SEUS", O QUE O ATENDENTE CRIA É DELE (issue #2547) ──────────
  //
  // Em `visibility_mode = 'own'` a policy de `crm_leads` só deixa o Atendente
  // gravar o negócio que ele enxergaria depois — o que tem ELE de responsável.
  // O "Novo Lead" não manda responsável, então a criação era recusada (500, e
  // 403 explicado desde o #2556). Decisão do mantenedor (opção A): sem
  // responsável no corpo, o responsável é o próprio Atendente. Ele passa pela
  // mesma régua de atribuição de quem manda o campo (`ownerPatchOrThrow`:
  // membro ativo, `owner_kind`, `assigned_at`).
  //
  // Só quando o corpo NÃO menciona dono: `owner_user_id: null` explícito ou um
  // colega de responsável continuam sendo pedidos que a regra recusa (403).
  // Gerente e admin enxergam a organização inteira e criam como sempre. O modo
  // vem da org do cookie validado, nunca do corpo — admin client, como em
  // `app/app/layout.tsx`.
  if (
    activeOrg.role === "agent" &&
    input.owner_user_id === undefined &&
    input.owner_agent_id === undefined
  ) {
    // Um client só para as duas leituras do modo/carteira (service-role: RLS
    // não segura nada aqui, então `organization_id` junto em todo `.eq`).
    const admin = createAdminClient();
    const { data: orgRow, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", activeOrg.orgId)
      .maybeSingle();
    // Leitura do modo falhou: segue SEM o padrão e registra. Seguir não amplia
    // acesso (a RLS de `crm_leads` lê o mesmo modo e decide); derrubar a criação
    // criaria uma falha nova nos modos em que ela daria certo — as leituras
    // vizinhas deste fluxo (moeda, origem) também degradam em vez de falhar.
    if (orgErr) {
      logger.error("leads.create: leitura do modo de visibilidade falhou; segue sem responsável padrão", {
        requestId,
        orgId: activeOrg.orgId,
        error: orgErr.message,
      });
    }
    const modo = (orgRow?.settings as { visibility_mode?: VisibilityMode } | null)?.visibility_mode;
    // `modo === "own"` estava escrito à mão aqui, na tela do Inbox e no catálogo
    // de recursos — três cópias da MESMA pergunta. Agora ela é um predicado só
    // (`somenteOProprio`), e a #3479 é o que acontece quando uma das cópias fica
    // para trás: no negócio o criador vira responsável, na conversa não.
    if (somenteOProprio(modo)) {
      // ─── CARTEIRA DE OUTRO VENDEDOR (issue #2591, regra 4) ─────────────────
      //
      // O padrão do #2547 acima dá o negócio a quem o criou — mas isso só é
      // justo enquanto ninguém é o DONO do cliente. Com o contato na carteira
      // de outro vendedor, o que o Atendente acabou de fazer foi riscar um
      // cliente do colega sem ninguém avisar. A issue decide: com carteira de
      // outro vendedor o negócio recusa com o motivo (403 explicado, molde do
      // #2556) em vez de nascer silenciosamente no nome errado.
      //
      // O dono que NÃO conta (viewer, revogado, de outra org) passa como
      // `donoDaCarteira: null` — aí nada muda, que é o padrão.
      const carteira = await carteiraDoContato(admin, activeOrg.orgId, input.contact_id);
      if (
        recusaNegocioNaCarteiraDeOutro({
          modo,
          criadorId: authUser.id,
          donoDaCarteira: carteira.qualificado ? carteira.dono : null,
        })
      ) {
        return fail("carteira_de_outro_vendedor", traduzir(MOTIVO_DA_RECUSA, authUser.idioma), 403, {
          requestId,
        });
      }
      input = { ...input, owner_user_id: authUser.id };
    }
  }

  const supabase = await createClient();

  // ─── AVISO DE NEGÓCIO ABERTO DUPLICADO (issue #1751) ───────────────────────
  //
  // Antes do INSERT, porque o aviso descreve o mundo em que a pessoa pediu a
  // criação — consultado depois, o negócio NOVO entraria na própria contagem.
  //
  // A consulta nunca recusa: a migration 0256 decidiu que um cliente PODE ter
  // dois negócios abertos, então o segundo nasce e a resposta traz
  // `meta.avisos: ["negocio_aberto_existente"]` com o negócio que já existe,
  // para a tela mostrar o aviso com link. Sem contato não há o que perguntar —
  // lead órfão é caminho legítimo (#852).
  const negocioExistente = input.contact_id
    ? await negocioAbertoExistente(supabase, {
        organizationId: activeOrg.orgId,
        contactId: input.contact_id,
        pipelineId: input.pipeline_id,
      })
    : null;

  try {
    const lead = await createLeadHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: authUser.id },
        requestId,
        idioma: authUser.idioma,
      },
      input as CreateLeadInput,
    );
    return ok(lead, {
      requestId,
      status: 201,
      // `meta` só quando há aviso: uma resposta sem `meta` continua sem
      // `meta`, e o que muda é acrescentar, nunca esconder.
      ...(negocioExistente
        ? {
            meta: {
              avisos: [AVISO_NEGOCIO_ABERTO_EXISTENTE],
              negocio_aberto_existente: negocioExistente,
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * CRIAR CARD POR TOKEN (`Bearer dsk_…` com `mcp:write`, papel `agent` — o mesmo
 * da tool MCP `crm_create_lead`). Existe para integração de servidor (ERP), que
 * não tem navegador e até aqui só criava card pelo envelope JSON-RPC do MCP.
 *
 * Faz o que a tool faz, pelo mesmo `createLeadHandler`: org da LINHA DO TOKEN,
 * nunca do corpo, e o handler confere funil, etapa, contato e responsável
 * contra essa org — o client do token ignora a RLS. O padrão de responsável e a
 * recusa por carteira de outro vendedor (#2547, #2591) ficam no ramo da sessão:
 * respondem a "o Atendente que criou", e um token não é um Atendente. O aviso
 * de negócio aberto duplicado (#1751) vale igual, porque descreve o cliente.
 */
async function criarPorToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;

  // Idempotência (opcional): o ERP que repete a chamada depois de um timeout
  // recebe o MESMO card de volta, em vez de criar o segundo.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !UUID.test(chave)) {
    return fail("validation_failed", "Idempotency-Key deve ser um UUID.", 400, { requestId });
  }

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "leads", requestId);
  if (tetoEstourado) return tetoEstourado;

  let input: CreateLeadPorTokenInput;
  try {
    input = await validateRequest(createLeadPorTokenSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const etapaRecusada = await recusaDaEtapaParaToken(authz.supabase, {
    organizationId: authz.organizationId,
    stageId: input.stage_id,
    uso: "criar",
    requestId,
  });
  if (etapaRecusada) return etapaRecusada;

  const negocioExistente = input.contact_id
    ? await negocioAbertoExistente(authz.supabase, {
        organizationId: authz.organizationId,
        contactId: input.contact_id,
        pipelineId: input.pipeline_id,
      })
    : null;

  /** O corpo da resposta, como o recibo o guarda: o card e, se houver, o aviso. */
  type Criado = { data: Record<string, unknown>; meta?: Record<string, unknown> };
  const criar = async (): Promise<Criado> => {
    // `external_id` já ocupado na origem: 409 com o id do negócio que existe.
    // Dentro de `criar`, para que a repetição COM a mesma Idempotency-Key devolva
    // o recibo do 201 em vez de cair aqui. A corrida entre esta consulta e o
    // INSERT é do 23505 no handler.
    if (input.external_id) {
      const existente = await leadDaOrigemExterna(
        authz.supabase,
        authz.organizationId,
        input.source,
        input.external_id,
      );
      if (existente) {
        throw leadJaExiste({ organization_id: authz.organizationId, actor: authz.actor, requestId }, existente);
      }
    }
    const lead = await createLeadHandler(
      authz.supabase,
      { organization_id: authz.organizationId, actor: authz.actor, requestId },
      input,
    );
    return {
      data: lead,
      ...(negocioExistente
        ? {
            meta: {
              avisos: [AVISO_NEGOCIO_ABERTO_EXISTENTE],
              negocio_aberto_existente: negocioExistente,
            },
          }
        : {}),
    };
  };

  try {
    const desfecho: DesfechoIdempotente<Criado> =
      chave === null
        ? { tipo: "executou", resposta: await criar(), status: 201 }
        : await comIdempotencia({
            // O client do token ignora a RLS: quem isola é `organizationId`,
            // que o helper filtra em toda consulta.
            db: authz.supabase,
            organizationId: authz.organizationId,
            endpoint: "POST /api/v1/leads",
            chave,
            corpo: input, // o corpo VALIDADO define a identidade da operação
            executar: async () => ({ resposta: await criar(), status: 201 }),
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
    return ok(desfecho.resposta.data, {
      requestId,
      status: 201,
      ...(desfecho.resposta.meta ? { meta: desfecho.resposta.meta } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, "POST /api/v1/leads");
    throw err;
  }
}
