/**
 * GET /api/v1/leads, /leads/{id} e /leads/by-external/{source}/{external_id}
 * por Bearer `dsk_…` (ERP) — e o ramo da sessão, que segue igual.
 *
 * O banco é em memória e APLICA os filtros (organização, status, cursor...):
 * um filtro esquecido aparece como vazamento, não como mock verde.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map([["user-1", "Ana Vendedora"]])),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PESSOAL = "99999999-9999-4999-8999-999999999999";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Linha = Record<string, unknown>;

function lead(n: number, extra: Linha = {}): Linha {
  return {
    id: id(n),
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    title: `Pedido ${n}`,
    status: "open",
    source: "erp",
    external_id: `ped-${n}`,
    owner_user_id: null,
    contact_id: null,
    updated_at: `2026-05-0${n}T10:00:00+00:00`,
    source_metadata: {},
    ...extra,
  };
}

/** Banco em memória com o subconjunto de PostgREST que as rotas usam. */
function banco(tabelas: Record<string, Linha[]>) {
  const from = (t: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    const ordens: Array<[string, boolean]> = [];
    let teto = Infinity;
    const q: Record<string, unknown> = {};
    const resultado = () => {
      let rows = (tabelas[t] ?? []).filter((l) => filtros.every((f) => f(l)));
      for (const [c, asc] of [...ordens].reverse()) {
        rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
      }
      return rows.slice(0, teto);
    };
    Object.assign(q, {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      gte: (c: string, v: string) => (filtros.push((l) => Date.parse(String(l[c])) >= Date.parse(v)), q),
      not: (c: string, _op: string, lista: string) => {
        const ids = lista.replace(/[()]/g, "").split(",");
        filtros.push((l) => !ids.includes(String(l[c])));
        return q;
      },
      or: (expr: string) => {
        const m = /^updated_at\.gt\.(.+),and\(updated_at\.eq\.(.+),id\.gt\.(.+)\)$/.exec(expr);
        if (!m) throw new Error(`or() não suportado: ${expr}`);
        const [, a, b, i] = m;
        filtros.push(
          (l) =>
            Date.parse(String(l.updated_at)) > Date.parse(a!) ||
            (Date.parse(String(l.updated_at)) === Date.parse(b!) && String(l.id) > i!),
        );
        return q;
      },
      order: (c: string, o: { ascending: boolean }) => (ordens.push([c, o.ascending]), q),
      limit: (n: number) => ((teto = n), q),
      maybeSingle: async () => ({ data: resultado()[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res({ data: resultado(), error: null }),
    });
    return q;
  };
  return { from } as never;
}

function leads(): Linha[] {
  return [
    lead(1),
    lead(2, { status: "won" }),
    lead(3, { owner_user_id: "user-1", source_metadata: { origem: "x", meta_capi_lead_birth_v1: "SEGREDO" } }),
    lead(4, { contact_id: PESSOAL, external_id: "ped-pessoal" }),
    lead(5, { organization_id: OUTRA, external_id: "ped-1" }), // mesma chave, outra org
  ];
}

function dbPadrao() {
  return banco({
    crm_leads: leads(),
    contacts: [{ id: PESSOAL, organization_id: ORG, is_personal: true }],
    crm_stages: [{ id: ETAPA, organization_id: ORG, name: "Proposta" }],
    crm_pipelines: [{ id: FUNIL, organization_id: ORG, name: "Vendas" }],
  });
}

function get(caminho: string, headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest(`http://localhost${caminho}`, { method: "GET", headers });
}

function tokenOk(scopes: string[] = ["mcp:read"], role = "viewer") {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: role as never,
    actor: { type: "api_token", id: "tok-1", role: role as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

const corpoDe = async (res: Response) =>
  (await res.json()) as { data: Linha & Linha[]; meta?: { cursor: string | null; has_more: boolean }; error?: { code: string; details?: unknown } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(dbPadrao());
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/v1/leads/{id}", () => {
  const ctx = (i: string) => ({ params: Promise.resolve({ id: i }) });

  it("token mcp:read → 200 com etapa, funil, dono e demais campos, sem a prova de meta", async () => {
    tokenOk();
    const { GET } = await import("./[id]/route");

    const res = await GET(get(`/api/v1/leads/${id(3)}`), ctx(id(3)));

    expect(res.status).toBe(200);
    const { data } = await corpoDe(res);
    expect(data).toMatchObject({
      id: id(3),
      status: "open",
      external_id: "ped-3",
      source: "erp",
      stage_name: "Proposta",
      pipeline_name: "Vendas",
      stage: { id: ETAPA, name: "Proposta" },
      owner_user_name: "Ana Vendedora",
    });
    expect(JSON.stringify(data)).not.toContain("SEGREDO");
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("negócio de outra organização → 404 (id conhecido, mas da outra casa)", async () => {
    tokenOk();
    const { GET } = await import("./[id]/route");

    const res = await GET(get(`/api/v1/leads/${id(5)}`), ctx(id(5)));

    expect(res.status).toBe(404);
    expect(JSON.stringify(await corpoDe(res))).not.toContain("Pedido 5");
  });

  it("negócio de contato pessoal → 404", async () => {
    tokenOk();
    const { GET } = await import("./[id]/route");
    expect((await GET(get(`/api/v1/leads/${id(4)}`), ctx(id(4)))).status).toBe(404);
  });

  it("id que não é UUID → 404, sem consultar o banco", async () => {
    tokenOk();
    const { GET } = await import("./[id]/route");
    expect((await GET(get("/api/v1/leads/abc"), ctx("abc"))).status).toBe(404);
  });

  it("leitura por token conta no teto: acima dele, 429 com Retry-After e nada é lido", async () => {
    const { GET } = await import("./[id]/route");
    tokenOk(["mcp:read"]);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await GET(get(`/api/v1/leads/${id(1)}`), ctx(id(1)));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("token sem mcp:read → 403; inválido → 401", async () => {
    const { GET } = await import("./[id]/route");
    tokenOk(["mcp:write"]);
    expect((await GET(get(`/api/v1/leads/${id(1)}`), ctx(id(1)))).status).toBe(403);

    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    expect((await GET(get(`/api/v1/leads/${id(1)}`), ctx(id(1)))).status).toBe(401);
  });

  it("sessão: usa o client da sessão (RLS), e a organização é a do cookie", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: ORG, role: "viewer" },
      user: { id: "u-1", idioma: "pt-BR" },
    } as never);
    // A RLS do "só os seus" esconderia este negócio: o client da sessão não o devolve.
    vi.mocked(createClient).mockResolvedValue(banco({ crm_leads: [], contacts: [] }));
    const { GET } = await import("./[id]/route");

    const res = await GET(get(`/api/v1/leads/${id(1)}`, {}), ctx(id(1)));

    expect(res.status).toBe(404);
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/leads/by-external/{source}/{external_id}", () => {
  const ctx = (source: string, external_id: string) => ({ params: Promise.resolve({ source, external_id }) });

  it("acha pelo par na organização do TOKEN — a chave igual de outra org não conta", async () => {
    tokenOk();
    const { GET } = await import("./by-external/[source]/[external_id]/route");

    const res = await GET(get("/api/v1/leads/by-external/erp/ped-1"), ctx("erp", "ped-1"));

    expect(res.status).toBe(200);
    expect((await corpoDe(res)).data).toMatchObject({ id: id(1), organization_id: ORG, pipeline_name: "Vendas" });
  });

  it("par inexistente → 404; negócio de pessoal → 404", async () => {
    tokenOk();
    const { GET } = await import("./by-external/[source]/[external_id]/route");

    expect((await GET(get("/x"), ctx("erp", "nao-existe"))).status).toBe(404);
    expect((await GET(get("/x"), ctx("erp", "ped-pessoal"))).status).toBe(404);
  });

  it("sem escopo → 403", async () => {
    tokenOk(["mcp:write"]);
    const { GET } = await import("./by-external/[source]/[external_id]/route");
    expect((await GET(get("/x"), ctx("erp", "ped-1"))).status).toBe(403);
  });
});

describe("GET /api/v1/leads", () => {
  it("lista só a organização do token, sem pessoal, em ordem (updated_at, id) e sem a prova de meta", async () => {
    tokenOk();
    const { GET } = await import("./route");

    const res = await GET(get("/api/v1/leads"));

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect((corpo.data as Linha[]).map((l) => l.id)).toEqual([id(1), id(2), id(3)]);
    expect(corpo.meta).toEqual({ cursor: null, has_more: false });
    expect(JSON.stringify(corpo)).not.toContain("SEGREDO");
    expect((corpo.data as Linha[])[2]).toMatchObject({ owner_user_name: "Ana Vendedora", stage_name: "Proposta" });
  });

  it("filtros: status, source, external_id e updated_since", async () => {
    tokenOk();
    const { GET } = await import("./route");
    const ids = async (qs: string) =>
      ((await corpoDe(await GET(get(`/api/v1/leads?${qs}`)))).data as Linha[]).map((l) => l.id);

    expect(await ids("status=won")).toEqual([id(2)]);
    expect(await ids("source=erp&external_id=ped-3")).toEqual([id(3)]);
    expect(await ids("source=outra")).toEqual([]);
    expect(await ids("updated_since=2026-05-02T00:00:00Z")).toEqual([id(2), id(3)]);
  });

  it("pagina por cursor opaco sem repetir nem pular", async () => {
    tokenOk();
    const { GET } = await import("./route");

    const p1 = await corpoDe(await GET(get("/api/v1/leads?limit=2")));
    expect((p1.data as Linha[]).map((l) => l.id)).toEqual([id(1), id(2)]);
    expect(p1.meta?.has_more).toBe(true);
    expect(p1.meta?.cursor).toBeTruthy();

    const p2 = await corpoDe(await GET(get(`/api/v1/leads?limit=2&cursor=${p1.meta!.cursor}`)));
    expect((p2.data as Linha[]).map((l) => l.id)).toEqual([id(3)]);
    expect(p2.meta).toEqual({ cursor: null, has_more: false });
  });

  it("cursor adulterado → 400 invalid_cursor (nunca chega ao filtro do banco)", async () => {
    tokenOk();
    const { GET } = await import("./route");
    const mau = Buffer.from(JSON.stringify({ updated_at: "x),id.eq.1", id: id(1) })).toString("base64url");

    for (const cursor of ["lixo", mau]) {
      const res = await GET(get(`/api/v1/leads?cursor=${cursor}`));
      expect(res.status).toBe(400);
      expect((await corpoDe(res)).error?.code).toBe("invalid_cursor");
    }
  });

  it("query inválida → 422; limit acima de 100 → 422", async () => {
    tokenOk();
    const { GET } = await import("./route");
    expect((await GET(get("/api/v1/leads?status=qualquer"))).status).toBe(422);
    expect((await GET(get("/api/v1/leads?limit=101"))).status).toBe(422);
    expect((await GET(get("/api/v1/leads?updated_since=ontem"))).status).toBe(422);
  });

  it("sem escopo → 403; token inválido → 401", async () => {
    const { GET } = await import("./route");
    tokenOk(["mcp:write"]);
    expect((await GET(get("/api/v1/leads"))).status).toBe(403);
    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    expect((await GET(get("/api/v1/leads"))).status).toBe(401);
  });

  it("sessão: lê pelo client da sessão (a RLS decide) e não toca o admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: ORG, role: "viewer" },
      user: { id: "u-1", idioma: "pt-BR" },
    } as never);
    vi.mocked(createClient).mockResolvedValue(
      banco({ crm_leads: [lead(1)], contacts: [], crm_stages: [], crm_pipelines: [] }),
    );
    const { GET } = await import("./route");

    const res = await GET(get("/api/v1/leads", {}));

    expect(res.status).toBe(200);
    expect(((await corpoDe(res)).data as Linha[]).map((l) => l.id)).toEqual([id(1)]);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
