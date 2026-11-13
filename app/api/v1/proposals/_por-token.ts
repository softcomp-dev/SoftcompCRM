/**
 * Propostas (com os itens do pedido) chamadas por Bearer `dsk_…` — a porta do ERP.
 *
 * Os itens do pedido moram em `crm_proposal_items`, presos à proposta (doutrina
 * DIRC: não há tabela de item no negócio). Por token só se lê, cria e edita o
 * RASCUNHO e seus itens; o que tem efeito fora do CRM continua só pela tela:
 * enviar ao cliente (`/send`), PDF/documento (`/documento`, `/previa`),
 * decisão/aceite (`/decide`), revisão, modelo, assistente e descartar (DELETE).
 *
 * Mesmas regras da tela (`route.ts`, `[id]/route.ts`):
 *  - organização da LINHA DO TOKEN; o client é o de serviço (ignora a RLS), então
 *    toda consulta filtra `organization_id`;
 *  - `lead_id` do corpo só vale se o negócio é da organização; o contato da
 *    proposta é o do negócio (nunca vem do corpo);
 *  - preço de item com `product_id` vem do catálogo da organização, na moeda
 *    dela; produto de outra organização é recusado (422);
 *  - capacidade "propostas" desligada na organização → 404, como na tela.
 *
 * A diferença de forma: a criação aceita `Idempotency-Key`, e a lista é paginada
 * por cursor. O `select("*")` da tela não é usado — `pdf_path`, snapshots do
 * modelo e o briefing da IA não são contrato de integração.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken, type AuthDual } from "@/lib/api/auth-dual";
import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import { falhaDoHandlerParaToken } from "@/lib/api/integracao-por-token";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { resolverAvisoDeRevisaoSeProntaOuEncerrada } from "@/lib/propostas/aviso-de-revisao";
import { fusoDaOrganizacao, somarDiasNoFuso } from "@/lib/propostas/data-no-fuso";
import { resolverItensDaProposta } from "@/lib/propostas/itens";
import { resolverPadroesDaProposta } from "@/lib/propostas/padroes-da-organizacao";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { propostaCreateSchema, propostaItemSchema } from "@/lib/schemas/propostas";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const COLUNAS_DA_PROPOSTA =
  "id, lead_id, contact_id, status, titulo, condicoes, total_cents, moeda, valid_until, numero, ano, versao, substitui_id, revision, pricing_status, prazo_dias_uteis, pagamento, sent_at, decided_at, decision_reason, created_at, updated_at";
const COLUNAS_DA_LISTA = "id, lead_id, contact_id, titulo, status, total_cents, moeda, numero, ano, versao, valid_until, created_at";
const COLUNAS_DO_ITEM = "id, proposal_id, product_id, descricao, quantidade, preco_unitario_cents, desconto_cents, position";

const patchSchema = z.object({
  revision: z.number().int().positive(),
  titulo: z.string().trim().min(1).max(200).optional(),
  condicoes: z.string().max(4000).nullable().optional(),
  valid_until: z.string().date().nullable().optional(),
  prazo_dias_uteis: z.number().int().min(1).max(365).nullable().optional(),
  pagamento: z.string().trim().max(500).nullable().optional(),
  itens: z.array(propostaItemSchema),
});

type Autorizado = Extract<AuthDual, { ok: true }>;

function requestIdDe(req: NextRequest): string {
  return req.headers.get("x-request-id") ?? randomUUID();
}

/** Recusa de negócio que sai de DENTRO da operação idempotente (não vira recibo). */
function recusa(status: number, code: string, message: string, details?: Record<string, unknown>, requestId = ""): ApiError {
  return new ApiError(status, code, details, requestId, message);
}

/** Autoriza (token), confere a capacidade "propostas" e, na escrita, a guarda de suporte. */
async function entrar(
  req: NextRequest,
  requestId: string,
  modo: "leitura" | "escrita",
): Promise<{ ok: true; authz: Autorizado } | { ok: false; response: Response }> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_proposals",
    role: modo === "leitura" ? "viewer" : "agent",
    scope: modo === "leitura" ? "mcp:read" : "mcp:write",
  });
  if (!authz.ok) return authz;
  if (modo === "leitura") {
    // Leitura por token também conta no teto (o desenho de GET /pipelines).
    const tetoDeLeitura = await tetoDeEscritaDoToken(authz, "proposals_leitura", requestId);
    if (tetoDeLeitura) return { ok: false, response: tetoDeLeitura };
  }
  if (modo === "escrita") {
    const suporte = await requireSupportWrite();
    if (suporte) return { ok: false, response: suporte };
  }
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return { ok: false, response: desligada };
  return { ok: true, authz };
}

function corpoInvalido(parsed: z.ZodError, requestId: string): Response {
  return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.flatten() });
}

interface Cursor {
  created_at: string;
  id: string;
}
function codificar(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodificar(bruto: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as Cursor;
    if (typeof c.id !== "string" || typeof c.created_at !== "string") return null;
    // O valor entra num filtro `.or()` do PostgREST: só a forma de data e de UUID passa.
    if (!UUID.test(c.id) || Number.isNaN(Date.parse(c.created_at))) return null;
    return c;
  } catch {
    return null;
  }
}

export async function listarPorToken(req: NextRequest): Promise<Response> {
  const requestId = requestIdDe(req);
  const entrada = await entrar(req, requestId, "leitura");
  if (!entrada.ok) return entrada.response;
  const { authz } = entrada;

  const params = req.nextUrl.searchParams;
  const limitBruto = Number(params.get("limit") ?? "50");
  const limit = Number.isFinite(limitBruto) && limitBruto > 0 ? Math.min(Math.floor(limitBruto), 200) : 50;
  const status = params.get("status");
  const leadId = params.get("lead_id");
  if (leadId && !UUID.test(leadId)) {
    return fail("validation_failed", "lead_id inválido.", 422, { requestId });
  }

  let q = authz.supabase
    .from("crm_proposals")
    .select(COLUNAS_DA_LISTA)
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (status) q = q.eq("status", status);
  if (leadId) q = q.eq("lead_id", leadId);

  const cursorBruto = params.get("cursor");
  if (cursorBruto) {
    const c = decodificar(cursorBruto);
    if (!c) return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
    q = q.or(`created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`);
  }

  const { data, error } = await q;
  if (error) return fail("internal_error", "Falha ao listar propostas.", 500, { requestId });
  const linhas = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;
  const ultima = pagina[pagina.length - 1];
  const cursor = temMais && ultima ? codificar({ created_at: String(ultima.created_at), id: String(ultima.id) }) : null;
  return ok(pagina, { requestId, meta: { cursor: cursor ?? undefined, has_more: temMais } });
}

export async function lerPorToken(req: NextRequest, id: string): Promise<Response> {
  const requestId = requestIdDe(req);
  const entrada = await entrar(req, requestId, "leitura");
  if (!entrada.ok) return entrada.response;
  const { authz } = entrada;
  if (!UUID.test(id)) return fail("validation_failed", "Campos inválidos.", 422, { requestId });

  const { data: proposta, error } = await authz.supabase
    .from("crm_proposals")
    .select(COLUNAS_DA_PROPOSTA)
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", "Falha ao carregar a proposta.", 500, { requestId });
  if (!proposta) return fail("not_found", "Proposta não encontrada.", 404, { requestId });

  const { data: itens, error: itensErro } = await authz.supabase
    .from("crm_proposal_items")
    .select(COLUNAS_DO_ITEM)
    .eq("organization_id", authz.organizationId)
    .eq("proposal_id", id)
    .order("position", { ascending: true });
  if (itensErro) return fail("internal_error", "Falha ao carregar os itens.", 500, { requestId });

  // Preço ATUAL do catálogo junto do item, para o ERP detectar drift (uma consulta em lote).
  const lista = (itens ?? []) as unknown as Array<{ product_id: string | null } & Record<string, unknown>>;
  const idsDeProduto = [...new Set(lista.map((it) => it.product_id).filter((p): p is string => p !== null))];
  const precoAtual = new Map<string, number>();
  if (idsDeProduto.length > 0) {
    const { data: produtos } = await authz.supabase
      .from("catalog_products")
      .select("id, preco_cents")
      .eq("organization_id", authz.organizationId)
      .in("id", idsDeProduto);
    for (const p of (produtos ?? []) as Array<{ id: string; preco_cents: number }>) precoAtual.set(p.id, p.preco_cents);
  }
  const itensComDrift = lista.map((it) => ({
    ...it,
    preco_catalogo_atual_cents: it.product_id ? (precoAtual.get(it.product_id) ?? null) : null,
  }));

  return ok({ ...(proposta as unknown as Record<string, unknown>), itens: itensComDrift }, { requestId });
}

export async function criarPorToken(req: NextRequest): Promise<Response> {
  const requestId = requestIdDe(req);
  const entrada = await entrar(req, requestId, "escrita");
  if (!entrada.ok) return entrada.response;
  const { authz } = entrada;
  const orgId = authz.organizationId;

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !UUID.test(chave)) {
    return fail("validation_failed", "Idempotency-Key deve ser um UUID.", 400, { requestId });
  }
  const teto = await tetoDeEscritaDoToken(authz, "proposals", requestId);
  if (teto) return teto;

  const parsed = propostaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return corpoInvalido(parsed.error, requestId);
  const input = parsed.data;

  const criar = async () => {
    // O lead_id do corpo nunca é confiado sozinho: tem de ser da organização do TOKEN.
    const { data: lead } = await authz.supabase
      .from("crm_leads")
      .select("id, contact_id")
      .eq("organization_id", orgId)
      .eq("id", input.lead_id)
      .maybeSingle();
    if (!lead) throw recusa(404, "not_found", "Negócio não encontrado nesta organização.");
    if (!lead.contact_id) {
      throw recusa(
        422,
        "validation_failed",
        "Este negócio não tem um contato vinculado. Vincule um contato antes de criar a proposta.",
      );
    }

    // §5.3 — um rascunho aberto por negócio (o índice único decide sob corrida).
    const { data: existente } = await authz.supabase
      .from("crm_proposals")
      .select("id")
      .eq("organization_id", orgId)
      .eq("lead_id", input.lead_id)
      .eq("status", "rascunho")
      .maybeSingle();
    if (existente) {
      throw recusa(
        409,
        "validation_failed",
        "Este negócio já tem um rascunho de proposta aberto. Edite-o (PATCH) em vez de criar outro.",
        { rascunho_aberto_id: (existente as { id: string }).id },
      );
    }

    // A proposta nasce na moeda da organização; item de catálogo em outra moeda é recusado.
    const moeda = await moedaDaOrganizacao(authz.supabase, orgId);
    const resolvido = await resolverItensDaProposta(authz.supabase, orgId, input.itens, moeda);
    if (!resolvido.ok) throw recusa(422, "validation_failed", resolvido.motivo);

    const { data: org } = await authz.supabase.from("organizations").select("settings").eq("id", orgId).single();
    const padroes = resolverPadroesDaProposta((org as { settings?: unknown } | null)?.settings);
    let validade = input.valid_until;
    if (validade === undefined) {
      const fuso = await fusoDaOrganizacao(authz.supabase, orgId);
      validade = somarDiasNoFuso(new Date(), padroes.defaultValidDays, fuso);
    }

    const { data: proposta, error: propErr } = await authz.supabase
      .from("crm_proposals")
      .insert({
        organization_id: orgId,
        lead_id: input.lead_id,
        contact_id: lead.contact_id,
        titulo: input.titulo,
        condicoes: input.condicoes ?? padroes.defaultConditions,
        valid_until: validade ?? null,
        total_cents: resolvido.totalCents,
        pricing_status: resolvido.pricingStatus,
        moeda,
        status: "rascunho",
      })
      .select("id")
      .single();
    if (propErr) {
      if ((propErr as { code?: string }).code === "23505") {
        throw recusa(409, "validation_failed", "Este negócio já tem um rascunho de proposta aberto.");
      }
      throw recusa(500, "internal_error", "Falha ao criar a proposta.");
    }
    if (!proposta) throw recusa(500, "internal_error", "Falha ao criar a proposta.");

    if (resolvido.itens.length > 0) {
      const { error: itensErr } = await authz.supabase.from("crm_proposal_items").insert(
        resolvido.itens.map((it) => ({
          proposal_id: proposta.id,
          organization_id: orgId,
          product_id: it.product_id,
          descricao: it.descricao,
          quantidade: it.quantidade,
          preco_unitario_cents: it.preco_unitario_cents,
          desconto_cents: it.desconto_cents,
          position: it.position,
        })),
      );
      if (itensErr) {
        // Rascunho vazio ocuparia a trava de "um por negócio": desfaz o que ESTA chamada criou.
        await authz.supabase.from("crm_proposals").delete().eq("organization_id", orgId).eq("id", proposta.id);
        throw recusa(500, "internal_error", "Falha ao gravar os itens.");
      }
    }

    await emitLeadActivity(authz.supabase, {
      organizationId: orgId,
      leadId: input.lead_id,
      contactId: lead.contact_id,
      type: "proposal_drafted",
      sourceModule: "proposals",
      sourceId: proposta.id,
      actor: authz.actor,
      reason: `Rascunho de proposta criado: ${input.titulo}`,
    }).catch(() => null);

    void audit({
      action: "proposal.drafted",
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: orgId,
      resourceType: "crm_proposals",
      resourceId: proposta.id,
      metadata: { via: "token" },
      requestId,
    });

    return {
      resposta: { id: proposta.id, status: "rascunho", total_cents: resolvido.totalCents, moeda },
      status: 201,
    };
  };

  type Criada = Awaited<ReturnType<typeof criar>>["resposta"];
  try {
    const desfecho: DesfechoIdempotente<Criada> =
      chave === null
        ? { tipo: "executou", ...(await criar()) }
        : await comIdempotencia({
            db: authz.supabase,
            organizationId: orgId,
            endpoint: "POST /api/v1/proposals",
            chave,
            corpo: input, // o corpo VALIDADO define a identidade da operação
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
    if (err instanceof ApiError) return falhaDoHandlerParaToken(err, requestId, "POST /api/v1/proposals");
    throw err;
  }
}

export async function editarPorToken(req: NextRequest, id: string): Promise<Response> {
  const requestId = requestIdDe(req);
  const entrada = await entrar(req, requestId, "escrita");
  if (!entrada.ok) return entrada.response;
  const { authz } = entrada;
  const orgId = authz.organizationId;
  const teto = await tetoDeEscritaDoToken(authz, "proposals", requestId);
  if (teto) return teto;

  if (!UUID.test(id)) return fail("validation_failed", "Campos inválidos.", 422, { requestId });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return corpoInvalido(parsed.error, requestId);
  const input = parsed.data;

  const desatualizada = () =>
    fail(
      "proposal_context_stale",
      "A proposta mudou (ou não está mais em rascunho). Recarregue antes de editar.",
      409,
      { requestId },
    );

  // A edição não muda a moeda; os itens são resolvidos contra a moeda JÁ GRAVADA.
  // Proposta de outra organização cai no mesmo 409 ambíguo da tela (não revela existência).
  const { data: atual } = await authz.supabase
    .from("crm_proposals")
    .select("moeda")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!atual) return desatualizada();

  const resolvido = await resolverItensDaProposta(authz.supabase, orgId, input.itens, (atual as { moeda: string }).moeda);
  if (!resolvido.ok) return fail("validation_failed", resolvido.motivo, 422, { requestId });

  const { data: proposta, error } = await authz.supabase
    .from("crm_proposals")
    .update({
      ...(input.titulo !== undefined ? { titulo: input.titulo } : {}),
      ...(input.condicoes !== undefined ? { condicoes: input.condicoes } : {}),
      ...(input.valid_until !== undefined ? { valid_until: input.valid_until } : {}),
      ...(input.prazo_dias_uteis !== undefined ? { prazo_dias_uteis: input.prazo_dias_uteis } : {}),
      ...(input.pagamento !== undefined ? { pagamento: input.pagamento === "" ? null : input.pagamento } : {}),
      total_cents: resolvido.totalCents,
      pricing_status: resolvido.pricingStatus,
      revision: input.revision + 1,
    })
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("revision", input.revision)
    .eq("status", "rascunho")
    .select("id, revision")
    .maybeSingle();
  if (error) return fail("internal_error", "Falha ao editar a proposta.", 500, { requestId });
  if (!proposta) return desatualizada();

  const { error: apagarErro } = await authz.supabase
    .from("crm_proposal_items")
    .delete()
    .eq("organization_id", orgId)
    .eq("proposal_id", id);
  if (apagarErro) return fail("internal_error", "Falha ao remover os itens anteriores.", 500, { requestId });

  if (resolvido.itens.length > 0) {
    const { error: inserirErro } = await authz.supabase.from("crm_proposal_items").insert(
      resolvido.itens.map((it) => ({
        organization_id: orgId,
        proposal_id: id,
        product_id: it.product_id,
        descricao: it.descricao,
        quantidade: it.quantidade,
        preco_unitario_cents: it.preco_unitario_cents,
        desconto_cents: it.desconto_cents,
        position: it.position,
      })),
    );
    if (inserirErro) return fail("internal_error", "Falha ao gravar os itens.", 500, { requestId });
  }

  void resolverAvisoDeRevisaoSeProntaOuEncerrada(authz.supabase, orgId, id);

  void audit({
    action: "proposal.edited",
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "crm_proposals",
    resourceId: id,
    metadata: { via: "token" },
    requestId,
  });

  return ok(
    { id, revision: (proposta as { revision: number }).revision, total_cents: resolvido.totalCents },
    { requestId },
  );
}
