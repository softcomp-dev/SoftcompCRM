/**
 * Propostas (com os itens do pedido) por Bearer `dsk_…` — a porta do ERP.
 *
 * O que esta suíte prova, com um banco em memória que APLICA os filtros:
 * - GET/POST/PATCH funcionam por token, na organização do TOKEN, pelo client de serviço;
 * - escopo errado → 403; token inválido → 401; acima do teto → 429 nas escritas;
 * - isolamento: proposta, negócio e produto de OUTRA organização nunca aparecem nem são aceitos;
 * - o preço de item com `product_id` vem do catálogo, nunca do corpo;
 * - `Idempotency-Key` repetida devolve o mesmo rascunho e não cria o segundo;
 * - capacidade "propostas" desligada → 404, como na tela;
 * - DELETE com Bearer é recusado; o ramo de sessão segue o caminho de sempre.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { criarBanco, type BancoEmMemoria } from "./_banco-em-memoria";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/propostas/aviso-de-revisao", () => ({
  resolverAvisoDeRevisaoSeProntaOuEncerrada: vi.fn(async () => undefined),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => undefined) }));

let banco: BancoEmMemoria;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco.client }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");
const { audit } = await import("@/lib/audit");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const LEAD = "11111111-1111-4111-8111-111111111111";
const LEAD_ALHEIO = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const PRODUTO = "44444444-4444-4444-8444-444444444444";
const PRODUTO_ALHEIO = "55555555-5555-4555-8555-555555555555";
const PROPOSTA = "66666666-6666-4666-8666-666666666666";
const PROPOSTA_ALHEIA = "77777777-7777-4777-8777-777777777777";
const CHAVE = "5f0c6a52-6a3e-4b1d-9c1e-2f7a8b9c0d11";

const AUTH = { authorization: "Bearer dsk_abc_def" };

function tokenOk(scopes: string[] = ["mcp:read", "mcp:write"], role = "agent"): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: role as never,
    actor: { type: "api_token", id: "tok-1", role: role as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

function pedido(metodo: string, caminho: string, corpo?: unknown, headers: Record<string, string> = AUTH) {
  return new NextRequest(`http://localhost${caminho}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    headers: { "content-type": "application/json", ...headers },
  });
}

const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  banco = criarBanco();
  banco.tabelas.organizations = [
    { id: ORG, currency: "BRL", timezone: "America/Sao_Paulo", settings: {} },
    { id: OUTRA_ORG, currency: "USD", settings: {} },
  ];
  banco.tabelas.crm_leads = [
    { id: LEAD, organization_id: ORG, contact_id: CONTATO },
    { id: LEAD_ALHEIO, organization_id: OUTRA_ORG, contact_id: CONTATO },
  ];
  banco.tabelas.catalog_products = [
    { id: PRODUTO, organization_id: ORG, preco_cents: 3000, moeda: "BRL", ativo: true },
    { id: PRODUTO_ALHEIO, organization_id: OUTRA_ORG, preco_cents: 1, moeda: "USD", ativo: true },
  ];
  banco.tabelas.crm_proposals = [
    {
      id: PROPOSTA,
      organization_id: ORG,
      lead_id: LEAD,
      status: "rascunho",
      titulo: "Pedido 1",
      moeda: "BRL",
      revision: 1,
      total_cents: 0,
      pdf_path: "segredo/interno.pdf",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: PROPOSTA_ALHEIA,
      organization_id: OUTRA_ORG,
      lead_id: LEAD_ALHEIO,
      status: "rascunho",
      titulo: "De outra org",
      moeda: "USD",
      revision: 1,
      created_at: "2026-01-02T00:00:00.000Z",
    },
  ];
  banco.tabelas.crm_proposal_items = [
    { id: "i1", organization_id: ORG, proposal_id: PROPOSTA, product_id: null, descricao: "Frete", quantidade: 1, preco_unitario_cents: 500, desconto_cents: 0, position: 1 },
    { id: "i2", organization_id: OUTRA_ORG, proposal_id: PROPOSTA_ALHEIA, product_id: null, descricao: "Alheio", quantidade: 1, preco_unitario_cents: 9, desconto_cents: 0, position: 1 },
  ];
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(sePropostasDesligadas).mockResolvedValue(null);
  tokenOk();
});

describe("GET /api/v1/proposals — Bearer", () => {
  it("lista só as propostas da org do TOKEN, sem campos internos", async () => {
    const { GET } = await import("./route");
    const res = await GET(pedido("GET", "/api/v1/proposals"));
    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    const corpo = (await res.json()) as { data: Array<Record<string, unknown>>; meta: { has_more: boolean } };
    expect(corpo.data.map((p) => p.id)).toEqual([PROPOSTA]);
    expect(corpo.meta.has_more).toBe(false);
  });

  it("limit=1 com duas propostas da org: has_more e cursor opaco", async () => {
    banco.tabelas.crm_proposals!.push({
      id: "88888888-8888-4888-8888-888888888888",
      organization_id: ORG,
      lead_id: LEAD,
      status: "cancelada",
      titulo: "Outra",
      created_at: "2026-02-01T00:00:00.000Z",
    });
    const { GET } = await import("./route");
    const res = await GET(pedido("GET", "/api/v1/proposals?limit=1"));
    const corpo = (await res.json()) as { data: unknown[]; meta: { has_more: boolean; cursor?: string } };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.meta.has_more).toBe(true);
    expect(typeof corpo.meta.cursor).toBe("string");
  });

  it("cursor malformado → 400", async () => {
    const { GET } = await import("./route");
    const res = await GET(pedido("GET", "/api/v1/proposals?cursor=lixo"));
    expect(res.status).toBe(400);
  });

  it("token sem mcp:read → 403; token inválido → 401", async () => {
    const { GET } = await import("./route");
    tokenOk(["mcp:write"]);
    expect((await GET(pedido("GET", "/api/v1/proposals"))).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await GET(pedido("GET", "/api/v1/proposals"))).status).toBe(401);
  });

  it("capacidade propostas desligada → 404, como na tela", async () => {
    vi.mocked(sePropostasDesligadas).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }) as never,
    );
    const { GET } = await import("./route");
    expect((await GET(pedido("GET", "/api/v1/proposals"))).status).toBe(404);
    expect(vi.mocked(sePropostasDesligadas).mock.calls[0]?.[0]).toBe(ORG);
  });

  it("a sessão (sem Bearer) segue pelo requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    } as never);
    const { GET } = await import("./route");
    const res = await GET(pedido("GET", "/api/v1/proposals", undefined, {}));
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledOnce();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/proposals/{id} — Bearer", () => {
  it("devolve a proposta com os itens e o preço atual do catálogo; sem pdf_path", async () => {
    banco.tabelas.crm_proposal_items![0]!.product_id = PRODUTO;
    const { GET } = await import("./[id]/route");
    const res = await GET(pedido("GET", `/api/v1/proposals/${PROPOSTA}`), ctxId(PROPOSTA));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { itens: Array<Record<string, unknown>> } };
    expect(data.id).toBe(PROPOSTA);
    expect(data.pdf_path).toBeUndefined();
    expect(data.itens).toHaveLength(1);
    expect(data.itens[0]?.preco_catalogo_atual_cents).toBe(3000);
  });

  it("proposta de OUTRA organização → 404, nunca o dado", async () => {
    const { GET } = await import("./[id]/route");
    const res = await GET(pedido("GET", `/api/v1/proposals/${PROPOSTA_ALHEIA}`), ctxId(PROPOSTA_ALHEIA));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("De outra org");
  });
});

describe("POST /api/v1/proposals — Bearer", () => {
  const corpo = {
    lead_id: LEAD,
    titulo: "Pedido do ERP #1",
    itens: [
      { product_id: PRODUTO, descricao: "Cadeira", quantidade: 2, preco_unitario_cents: 1, desconto_cents: 0, position: 1 },
      { product_id: null, descricao: "Frete", quantidade: 1, preco_unitario_cents: 500, desconto_cents: 0, position: 2 },
    ],
  };

  beforeEach(() => {
    // O negócio do teste já tem rascunho; para criar, parte-se de um negócio sem.
    banco.tabelas.crm_proposals = banco.tabelas.crm_proposals!.filter((p) => p.id !== PROPOSTA);
    banco.tabelas.crm_proposal_items = [];
  });

  it("cria o rascunho na org do TOKEN; preço do item vem do catálogo, não do corpo", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/proposals", corpo));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; total_cents: number; moeda: string } };
    expect(data.total_cents).toBe(2 * 3000 + 500);
    expect(data.moeda).toBe("BRL");
    const criada = banco.tabelas.crm_proposals!.find((p) => p.id === data.id);
    expect(criada).toMatchObject({ organization_id: ORG, lead_id: LEAD, contact_id: CONTATO, status: "rascunho" });
    const itens = banco.tabelas.crm_proposal_items!.filter((i) => i.proposal_id === data.id);
    expect(itens).toHaveLength(2);
    expect(itens.every((i) => i.organization_id === ORG)).toBe(true);
    expect(itens.find((i) => i.product_id === PRODUTO)?.preco_unitario_cents).toBe(3000);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({ action: "proposal.drafted", actorApiTokenId: "tok-1", organizationId: ORG });
  });

  it("organization_id no corpo não escolhe a org (o campo é descartado)", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/proposals", { ...corpo, organization_id: OUTRA_ORG }));
    expect(res.status).toBe(201);
    expect(banco.tabelas.crm_proposals!.every((p) => p.organization_id !== OUTRA_ORG || p.id === PROPOSTA_ALHEIA)).toBe(true);
  });

  it("negócio de OUTRA organização → 404, nada gravado", async () => {
    const { POST } = await import("./route");
    const antes = banco.tabelas.crm_proposals!.length;
    const res = await POST(pedido("POST", "/api/v1/proposals", { ...corpo, lead_id: LEAD_ALHEIO }));
    expect(res.status).toBe(404);
    expect(banco.tabelas.crm_proposals).toHaveLength(antes);
  });

  it("produto de OUTRA organização → 422, nada gravado", async () => {
    const { POST } = await import("./route");
    const antes = banco.tabelas.crm_proposals!.length;
    const res = await POST(
      pedido("POST", "/api/v1/proposals", {
        ...corpo,
        itens: [{ product_id: PRODUTO_ALHEIO, descricao: "X", quantidade: 1, preco_unitario_cents: 1, desconto_cents: 0, position: 1 }],
      }),
    );
    expect(res.status).toBe(422);
    expect(banco.tabelas.crm_proposals).toHaveLength(antes);
  });

  it("negócio que já tem rascunho aberto → 409 com o id do existente", async () => {
    banco.tabelas.crm_proposals!.push({ id: PROPOSTA, organization_id: ORG, lead_id: LEAD, status: "rascunho" });
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/proposals", corpo));
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { details: { rascunho_aberto_id: string } } };
    expect(error.details.rascunho_aberto_id).toBe(PROPOSTA);
  });

  it("falha ao gravar os itens: o rascunho recém-criado é desfeito e o erro não vaza texto do banco", async () => {
    banco.falharInsert.crm_proposal_items = { message: "violates constraint crm_proposal_items_x" };
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/proposals", corpo));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("constraint");
    expect(banco.tabelas.crm_proposals!.filter((p) => p.lead_id === LEAD)).toHaveLength(0);
  });

  it("token sem mcp:write → 403, nada criado", async () => {
    tokenOk(["mcp:read"]);
    const { POST } = await import("./route");
    expect((await POST(pedido("POST", "/api/v1/proposals", corpo))).status).toBe(403);
  });

  it("leitura por token conta no teto: acima dele, 429", async () => {
    tokenOk(["mcp:read"]);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const { GET } = await import("./route");
    expect((await GET(pedido("GET", "/api/v1/proposals"))).status).toBe(429);
  });

  it("acima do teto → 429 com Retry-After, nada criado", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const { POST } = await import("./route");
    const antes = banco.tabelas.crm_proposals!.length;
    const res = await POST(pedido("POST", "/api/v1/proposals", corpo));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(banco.tabelas.crm_proposals).toHaveLength(antes);
  });

  it("Idempotency-Key repetida devolve o MESMO rascunho; corpo diferente com a mesma chave → 409", async () => {
    const { POST } = await import("./route");
    const a = await POST(pedido("POST", "/api/v1/proposals", corpo, { ...AUTH, "idempotency-key": CHAVE }));
    const b = await POST(pedido("POST", "/api/v1/proposals", corpo, { ...AUTH, "idempotency-key": CHAVE }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(((await b.json()) as { data: { id: string } }).data.id).toBe(((await a.json()) as { data: { id: string } }).data.id);
    expect(banco.tabelas.crm_proposals!.filter((p) => p.lead_id === LEAD)).toHaveLength(1);

    const c = await POST(pedido("POST", "/api/v1/proposals", { ...corpo, titulo: "Outro" }, { ...AUTH, "idempotency-key": CHAVE }));
    expect(c.status).toBe(409);
    expect(((await c.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });

  it("Idempotency-Key que não é UUID → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/proposals", corpo, { ...AUTH, "idempotency-key": "abc" }));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/v1/proposals/{id} — Bearer", () => {
  const edicao = {
    revision: 1,
    titulo: "Pedido 1 (revisado)",
    itens: [{ product_id: PRODUTO, descricao: "Cadeira", quantidade: 1, preco_unitario_cents: 1, desconto_cents: 0, position: 1 }],
  };

  it("substitui os itens, recalcula o total e incrementa a revision", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(pedido("PATCH", `/api/v1/proposals/${PROPOSTA}`, edicao), ctxId(PROPOSTA));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { revision: number; total_cents: number } };
    expect(data).toMatchObject({ revision: 2, total_cents: 3000 });
    const itens = banco.tabelas.crm_proposal_items!.filter((i) => i.proposal_id === PROPOSTA);
    expect(itens).toHaveLength(1);
    expect(itens[0]?.preco_unitario_cents).toBe(3000);
    // O item da outra organização segue intacto.
    expect(banco.tabelas.crm_proposal_items!.some((i) => i.proposal_id === PROPOSTA_ALHEIA)).toBe(true);
  });

  it("revision desatualizada → 409 e nada muda", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(pedido("PATCH", `/api/v1/proposals/${PROPOSTA}`, { ...edicao, revision: 7 }), ctxId(PROPOSTA));
    expect(res.status).toBe(409);
    expect(banco.tabelas.crm_proposal_items!.find((i) => i.id === "i1")).toBeTruthy();
  });

  it("proposta de OUTRA organização → 409 ambíguo (como na tela), nada alterado", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(pedido("PATCH", `/api/v1/proposals/${PROPOSTA_ALHEIA}`, edicao), ctxId(PROPOSTA_ALHEIA));
    expect(res.status).toBe(409);
    expect(banco.tabelas.crm_proposals!.find((p) => p.id === PROPOSTA_ALHEIA)?.titulo).toBe("De outra org");
  });

  it("produto de outra organização → 422 e os itens antigos ficam", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(
      pedido("PATCH", `/api/v1/proposals/${PROPOSTA}`, {
        ...edicao,
        itens: [{ product_id: PRODUTO_ALHEIO, descricao: "X", quantidade: 1, preco_unitario_cents: 1, desconto_cents: 0, position: 1 }],
      }),
      ctxId(PROPOSTA),
    );
    expect(res.status).toBe(422);
    expect(banco.tabelas.crm_proposal_items!.find((i) => i.id === "i1")).toBeTruthy();
  });

  it("sem mcp:write → 403; acima do teto → 429", async () => {
    const { PATCH } = await import("./[id]/route");
    tokenOk(["mcp:read"]);
    expect((await PATCH(pedido("PATCH", `/api/v1/proposals/${PROPOSTA}`, edicao), ctxId(PROPOSTA))).status).toBe(403);
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await PATCH(pedido("PATCH", `/api/v1/proposals/${PROPOSTA}`, edicao), ctxId(PROPOSTA))).status).toBe(429);
  });
});

describe("DELETE /api/v1/proposals/{id} — Bearer", () => {
  it("é recusado (403) e nada é descartado", async () => {
    const { DELETE } = await import("./[id]/route");
    const res = await DELETE(pedido("DELETE", `/api/v1/proposals/${PROPOSTA}`), ctxId(PROPOSTA));
    expect(res.status).toBe(403);
    expect(banco.tabelas.crm_proposals!.find((p) => p.id === PROPOSTA)?.status).toBe("rascunho");
    expect(requireRole).not.toHaveBeenCalled();
  });
});
