/**
 * Empresas (B2B) por Bearer `dsk_…` — a porta do ERP.
 *
 * O que esta suíte prova, com um banco em memória que APLICA os filtros e os
 * handlers REAIS da tela:
 * - GET lista/lê, POST cria e PATCH edita na organização do TOKEN;
 * - módulo `crm_b2b` desligado → 404 também para o token (igual à sessão);
 * - escopo errado → 403; token inválido → 401; papel abaixo de manager no POST → 403;
 * - isolamento: empresa de OUTRA organização → 404, nunca o dado;
 * - teto → 429 nas escritas; `Idempotency-Key` repetida não cria a segunda;
 * - DELETE com Bearer é recusado; a sessão (cookie) segue o caminho de sempre.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { moduloLigado } from "@/lib/instalacao/modulos";

import { criarBanco, type BancoEmMemoria } from "../proposals/_banco-em-memoria";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));
vi.mock("@/lib/crm-b2b/enrich", () => ({ enrichCompanyFromBrasilApi: vi.fn(async () => undefined) }));

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
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const EMPRESA_ALHEIA = "22222222-2222-4222-8222-222222222222";
const CHAVE = "5f0c6a52-6a3e-4b1d-9c1e-2f7a8b9c0d11";
const AUTH = { authorization: "Bearer dsk_abc_def" };

function tokenOk(scopes: string[] = ["mcp:read", "mcp:write"], role = "manager"): void {
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
  banco.tabelas.companies = [
    { id: EMPRESA, organization_id: ORG, legal_name: "Acme Ltda", trade_name: "Acme", updated_at: "2026-01-01" },
    { id: EMPRESA_ALHEIA, organization_id: OUTRA_ORG, legal_name: "Alheia SA", trade_name: "Alheia", updated_at: "2026-01-02" },
  ];
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  tokenOk();
});

describe("GET /api/v1/companies — Bearer", () => {
  it("lista só as empresas da org do TOKEN", async () => {
    const { GET } = await import("./route");
    const res = await GET(pedido("GET", "/api/v1/companies"));
    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((e) => e.id)).toEqual([EMPRESA]);
  });

  it("módulo crm_b2b desligado → 404 (o token é recusado igual à sessão)", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    const { GET } = await import("./route");
    const res = await GET(pedido("GET", "/api/v1/companies"));
    expect(res.status).toBe(404);
    expect(validateBearerToken).not.toHaveBeenCalled();
  });

  it("token sem mcp:read → 403; token inválido → 401", async () => {
    const { GET } = await import("./route");
    tokenOk(["mcp:write"]);
    expect((await GET(pedido("GET", "/api/v1/companies"))).status).toBe(403);
    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await GET(pedido("GET", "/api/v1/companies"))).status).toBe(401);
  });

  it("a sessão (sem Bearer) segue pelo requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) } as never);
    const { GET } = await import("./route");
    expect((await GET(pedido("GET", "/api/v1/companies", undefined, {}))).status).toBe(401);
    expect(requireRole).toHaveBeenCalledOnce();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/companies/{id} — Bearer", () => {
  it("lê a empresa da org do token", async () => {
    const { GET } = await import("./[id]/route");
    const res = await GET(pedido("GET", `/api/v1/companies/${EMPRESA}`), ctxId(EMPRESA));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { company: { id: string } } }).data.company.id).toBe(EMPRESA);
  });

  it("empresa de OUTRA organização → 404, nunca o dado", async () => {
    const { GET } = await import("./[id]/route");
    const res = await GET(pedido("GET", `/api/v1/companies/${EMPRESA_ALHEIA}`), ctxId(EMPRESA_ALHEIA));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("Alheia");
  });

  it("id que não é UUID → 404", async () => {
    const { GET } = await import("./[id]/route");
    expect((await GET(pedido("GET", "/api/v1/companies/x"), ctxId("x"))).status).toBe(404);
  });
});

describe("POST /api/v1/companies — Bearer", () => {
  const corpo = { legal_name: "Nova Ltda", trade_name: "Nova", email: "contato@nova.com" };

  it("cria na org do TOKEN (201), com o token como ator na auditoria", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/companies", corpo));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const criada = banco.tabelas.companies!.find((e) => e.id === data.id);
    expect(criada).toMatchObject({ organization_id: ORG, legal_name: "Nova Ltda", created_by: null });
    expect(vi.mocked(audit).mock.calls.some(([e]) => e.actorApiTokenId === "tok-1" && e.action === "companies.created")).toBe(true);
  });

  it("organization_id no corpo não escolhe a org", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/companies", { ...corpo, organization_id: OUTRA_ORG }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(banco.tabelas.companies!.find((e) => e.id === data.id)?.organization_id).toBe(ORG);
  });

  it("papel do token abaixo de manager → 403 (a tela também pede manager)", async () => {
    tokenOk(["mcp:write"], "agent");
    const { POST } = await import("./route");
    expect((await POST(pedido("POST", "/api/v1/companies", corpo))).status).toBe(403);
  });

  it("leitura por token conta no teto: acima dele, 429", async () => {
    const { GET } = await import("./route");
    tokenOk(["mcp:read"]);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await GET(pedido("GET", "/api/v1/companies"))).status).toBe(429);
  });

  it("sem mcp:write → 403; acima do teto → 429; nada criado", async () => {
    const { POST } = await import("./route");
    tokenOk(["mcp:read"]);
    expect((await POST(pedido("POST", "/api/v1/companies", corpo))).status).toBe(403);
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(pedido("POST", "/api/v1/companies", corpo));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(banco.tabelas.companies).toHaveLength(2);
  });

  it("corpo inválido → 422 com details; JSON malformado → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", "/api/v1/companies", { email: "nao-e-email" }));
    expect(res.status).toBe(422);
    const ruim = new NextRequest("http://localhost/api/v1/companies", {
      method: "POST",
      body: "{",
      headers: { ...AUTH, "content-type": "application/json" },
    });
    expect((await POST(ruim)).status).toBe(400);
  });

  it("Idempotency-Key repetida devolve a MESMA empresa; corpo diferente → 409", async () => {
    const { POST } = await import("./route");
    const a = await POST(pedido("POST", "/api/v1/companies", corpo, { ...AUTH, "idempotency-key": CHAVE }));
    const b = await POST(pedido("POST", "/api/v1/companies", corpo, { ...AUTH, "idempotency-key": CHAVE }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(((await b.json()) as { data: { id: string } }).data.id).toBe(((await a.json()) as { data: { id: string } }).data.id);
    expect(banco.tabelas.companies!.filter((e) => e.legal_name === "Nova Ltda")).toHaveLength(1);
    const c = await POST(pedido("POST", "/api/v1/companies", { ...corpo, legal_name: "Outra" }, { ...AUTH, "idempotency-key": CHAVE }));
    expect(c.status).toBe(409);
  });
});

describe("PATCH /api/v1/companies/{id} — Bearer", () => {
  it("edita a empresa da org do token", async () => {
    tokenOk(["mcp:write"], "agent");
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(pedido("PATCH", `/api/v1/companies/${EMPRESA}`, { phone: "+5531999990000" }), ctxId(EMPRESA));
    expect(res.status).toBe(200);
    expect(banco.tabelas.companies!.find((e) => e.id === EMPRESA)?.phone).toBe("+5531999990000");
  });

  it("empresa de OUTRA organização → 404 e nada muda", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(pedido("PATCH", `/api/v1/companies/${EMPRESA_ALHEIA}`, { phone: "1" }), ctxId(EMPRESA_ALHEIA));
    expect(res.status).toBe(404);
    expect(banco.tabelas.companies!.find((e) => e.id === EMPRESA_ALHEIA)?.phone).toBeUndefined();
  });

  it("sem mcp:write → 403; teto → 429", async () => {
    const { PATCH } = await import("./[id]/route");
    tokenOk(["mcp:read"]);
    expect((await PATCH(pedido("PATCH", `/api/v1/companies/${EMPRESA}`, { phone: "1" }), ctxId(EMPRESA))).status).toBe(403);
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await PATCH(pedido("PATCH", `/api/v1/companies/${EMPRESA}`, { phone: "1" }), ctxId(EMPRESA))).status).toBe(429);
  });
});

describe("DELETE /api/v1/companies/{id} — Bearer", () => {
  it("é recusado (403) e a empresa continua lá", async () => {
    const { DELETE } = await import("./[id]/route");
    const res = await DELETE(pedido("DELETE", `/api/v1/companies/${EMPRESA}`), ctxId(EMPRESA));
    expect(res.status).toBe(403);
    expect(banco.tabelas.companies!.some((e) => e.id === EMPRESA)).toBe(true);
    expect(requireRole).not.toHaveBeenCalled();
  });
});
