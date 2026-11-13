/**
 * POST /api/v1/leads/[id]/win e /lose por Bearer `dsk_…` — o ERP fecha "pedido
 * faturado" / "pedido cancelado" sem conhecer o id da etapa de fechamento.
 *
 * O banco aqui é em memória e APLICA os filtros (`eq`, `is`): o que prova o
 * isolamento é o lead da outra organização não ser achado pela consulta, não um
 * mock que devolve 404. `encerraDemanda` roda de verdade.
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
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");
const { audit } = await import("@/lib/audit");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUNIL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const ABERTA = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
const GANHA = "dddddddd-dddd-4ddd-8ddd-dddddddddd02";
const PERDIDA = "dddddddd-dddd-4ddd-8ddd-dddddddddd03";
const GANHA_B = "dddddddd-dddd-4ddd-8ddd-dddddddddd12";
const LEAD = "33333333-3333-4333-8333-333333333333";
const LEAD_B = "33333333-3333-4333-8333-333333333334";

type Linha = Record<string, unknown>;

/** Supabase em memória: `select/eq/is/order/limit/maybeSingle/update/insert`. */
function banco(tabelas: Record<string, Linha[]>) {
  const from = (nome: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let operacao: "select" | "update" | "insert" = "select";
    let patch: Linha = {};
    let novo: Linha = {};
    let ordem: [string, boolean] | null = null;
    let limite = Infinity;
    const linhas = (tabelas[nome] ??= []);
    const casa = () => {
      let r = linhas.filter((l) => filtros.every((f) => f(l)));
      if (ordem) {
        const [c, asc] = ordem;
        r = [...r].sort((a, b) => (Number(a[c]) - Number(b[c])) * (asc ? 1 : -1));
      }
      return r.slice(0, limite);
    };
    const executa = () => {
      if (operacao === "insert") {
        linhas.push({ ...novo });
        return { data: null, error: null };
      }
      if (operacao === "update") {
        for (const l of casa()) {
          Object.assign(l, patch);
          // O trigger `fn_crm_lead_close_on_stage`, no que importa aqui.
          if (nome === "crm_leads" && patch.stage_id) {
            const etapa = (tabelas.crm_stages ?? []).find((e) => e.id === patch.stage_id);
            l.status = etapa?.is_won ? "won" : etapa?.is_lost ? "lost" : "open";
          }
        }
        return { data: null, error: null };
      }
      return { data: casa(), error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      order: (c: string, o?: { ascending?: boolean }) => ((ordem = [c, o?.ascending !== false]), q),
      limit: (n: number) => ((limite = n), q),
      update: (p: Linha) => ((operacao = "update"), (patch = p), q),
      insert: (r: Linha) => ((operacao = "insert"), (novo = r), q),
      maybeSingle: async () => ({ data: (executa().data as Linha[] | null)?.[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res(executa()),
    };
    return q;
  };
  return { from } as never;
}

function dados() {
  return {
    crm_pipelines: [
      { id: FUNIL, organization_id: ORG, settings: {} },
      { id: FUNIL_B, organization_id: OUTRA_ORG, settings: {} },
    ],
    crm_stages: [
      { id: ABERTA, organization_id: ORG, pipeline_id: FUNIL, position: 1, is_won: false, is_lost: false, is_archived: false },
      { id: GANHA, organization_id: ORG, pipeline_id: FUNIL, position: 8, is_won: true, is_lost: false, is_archived: false },
      { id: PERDIDA, organization_id: ORG, pipeline_id: FUNIL, position: 9, is_won: false, is_lost: true, is_archived: false },
      { id: GANHA_B, organization_id: OUTRA_ORG, pipeline_id: FUNIL_B, position: 8, is_won: true, is_lost: false, is_archived: false },
    ],
    crm_leads: [
      { id: LEAD, organization_id: ORG, pipeline_id: FUNIL, stage_id: ABERTA, status: "open", contact_id: null, position_in_stage: 1 },
      { id: LEAD_B, organization_id: OUTRA_ORG, pipeline_id: FUNIL_B, stage_id: ABERTA, status: "open", contact_id: null, position_in_stage: 1 },
    ],
    crm_lead_activities: [],
  } as Record<string, Linha[]>;
}

function req(acao: "win" | "lose", body: unknown, id = LEAD, headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest(`http://localhost/api/v1/leads/${id}/${acao}`, {
    method: "POST",
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenOk(scopes: string[] = ["mcp:write"]): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: "agent" as never,
    actor: { type: "api_token", id: "tok-1", role: "agent" as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

let tabelas: Record<string, Linha[]>;
const doLead = (id: string) => tabelas.crm_leads!.find((l) => l.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = dados();
  vi.mocked(createAdminClient).mockReturnValue(banco(tabelas));
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/v1/leads/[id]/win — Bearer", () => {
  it("fecha como ganho na etapa de ganho DO FUNIL, sem o ERP saber o id dela", async () => {
    tokenOk();
    const { POST } = await import("./win/route");

    const res = await POST(req("win", { won_reason: "Pedido faturado" }), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(doLead(LEAD)).toMatchObject({ stage_id: GANHA, status: "won", won_reason: "Pedido faturado" });
    // A timeline e o audit levam o token como ator.
    expect(tabelas.crm_lead_activities).toHaveLength(1);
    expect(tabelas.crm_lead_activities![0]).toMatchObject({ type: "demand_closed", organization_id: ORG });
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({ action: "lead.won", organizationId: ORG });
  });

  it("corpo vazio é o contrato antigo: ganha sem motivo", async () => {
    tokenOk();
    const { POST } = await import("./win/route");

    const res = await POST(req("win", undefined), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(200);
    expect(doLead(LEAD).status).toBe("won");
  });

  it("funil com won_reason_required: sem motivo → 422 com details.faltando, nada muda", async () => {
    tokenOk();
    tabelas.crm_pipelines![0]!.settings = { won_reason_required: true };
    const { POST } = await import("./win/route");

    const res = await POST(req("win", {}), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { details?: { faltando?: Array<{ chave: string }> } } };
    expect(corpo.error.details?.faltando?.map((f) => f.chave)).toContain("won_reason");
    expect(doLead(LEAD).status).toBe("open");
  });

  it("motivo fora da lista do funil → 422 won_reason_invalid", async () => {
    tokenOk();
    tabelas.crm_pipelines![0]!.settings = { won_reasons: ["Preço"] };
    const { POST } = await import("./win/route");

    const res = await POST(req("win", { won_reason: "Outro" }), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("won_reason_invalid");
    expect(doLead(LEAD).status).toBe("open");
  });

  it("já ganho → 200 sem escrever de novo (idempotente)", async () => {
    tokenOk();
    Object.assign(doLead(LEAD), { status: "won", stage_id: GANHA });
    const { POST } = await import("./win/route");

    const res = await POST(req("win", {}), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(200);
    expect(tabelas.crm_lead_activities).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("negócio de OUTRA organização → 404, e nada dele muda", async () => {
    tokenOk();
    const { POST } = await import("./win/route");

    const res = await POST(req("win", {}, LEAD_B), { params: Promise.resolve({ id: LEAD_B }) });

    expect(res.status).toBe(404);
    expect(doLead(LEAD_B)).toMatchObject({ stage_id: ABERTA, status: "open" });
  });

  it("id que não é UUID → 404, sem chegar ao banco", async () => {
    tokenOk();
    const { POST } = await import("./win/route");

    const res = await POST(req("win", {}, "nao-e-uuid"), { params: Promise.resolve({ id: "nao-e-uuid" }) });

    expect(res.status).toBe(404);
  });

  it("campo desconhecido no corpo → 422 (recusado, não descartado)", async () => {
    tokenOk();
    const { POST } = await import("./win/route");

    const res = await POST(req("win", { stage_id: GANHA }), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(422);
    expect(doLead(LEAD).status).toBe("open");
  });

  it("sem mcp:write → 403; token inválido → 401; acima do teto → 429", async () => {
    const { POST } = await import("./win/route");
    const c = { params: Promise.resolve({ id: LEAD }) };

    tokenOk(["mcp:read"]);
    expect((await POST(req("win", {}), c)).status).toBe(403);

    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    expect((await POST(req("win", {}), c)).status).toBe(401);

    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await POST(req("win", {}), c)).status).toBe(429);

    expect(doLead(LEAD).status).toBe("open");
  });

  it("sessão (cookie) segue pelo requireRole e pelo client do usuário", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "user-1", idioma: "pt-BR" },
      org: { orgId: ORG },
    } as never);
    vi.mocked(createClient).mockResolvedValue(banco(tabelas));
    const { POST } = await import("./win/route");

    const res = await POST(req("win", {}, LEAD, {}), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(200);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(doLead(LEAD).status).toBe("won");
  });
});

describe("POST /api/v1/leads/[id]/lose — Bearer", () => {
  it("fecha como perdido na etapa de perda do funil, com o motivo", async () => {
    tokenOk();
    const { POST } = await import("./lose/route");

    const res = await POST(req("lose", { lost_reason: "Pedido cancelado" }), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(doLead(LEAD)).toMatchObject({ stage_id: PERDIDA, status: "lost", lost_reason: "Pedido cancelado" });
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({ action: "lead.lost", organizationId: ORG });
  });

  it("sem motivo → 422 lost_reason_required, nada muda", async () => {
    tokenOk();
    const { POST } = await import("./lose/route");

    const res = await POST(req("lose", {}), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("lost_reason_required");
    expect(doLead(LEAD).status).toBe("open");
  });

  it("negócio de OUTRA organização → 404, e nada dele muda", async () => {
    tokenOk();
    const { POST } = await import("./lose/route");

    const res = await POST(req("lose", { lost_reason: "x" }, LEAD_B), { params: Promise.resolve({ id: LEAD_B }) });

    expect(res.status).toBe(404);
    expect(doLead(LEAD_B)).toMatchObject({ stage_id: ABERTA, status: "open" });
  });

  it("funil sem etapa de perda → 422 pipeline_no_lost_stage", async () => {
    tokenOk();
    tabelas.crm_stages = tabelas.crm_stages!.filter((e) => e.id !== PERDIDA);
    const { POST } = await import("./lose/route");

    const res = await POST(req("lose", { lost_reason: "x" }), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("pipeline_no_lost_stage");
  });

  it("sem mcp:write → 403; token inválido → 401; acima do teto → 429", async () => {
    const { POST } = await import("./lose/route");
    const c = { params: Promise.resolve({ id: LEAD }) };

    tokenOk(["mcp:read"]);
    expect((await POST(req("lose", { lost_reason: "x" }), c)).status).toBe(403);

    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    expect((await POST(req("lose", { lost_reason: "x" }), c)).status).toBe(401);

    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await POST(req("lose", { lost_reason: "x" }), c)).status).toBe(429);

    expect(doLead(LEAD).status).toBe("open");
  });

  it("sessão (cookie) segue pelo requireRole e pelo client do usuário", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "user-1", idioma: "pt-BR" },
      org: { orgId: ORG },
    } as never);
    vi.mocked(createClient).mockResolvedValue(banco(tabelas));
    const { POST } = await import("./lose/route");

    const res = await POST(req("lose", { lost_reason: "Preço" }, LEAD, {}), { params: Promise.resolve({ id: LEAD }) });

    expect(res.status).toBe(200);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(doLead(LEAD).status).toBe("lost");
  });
});
