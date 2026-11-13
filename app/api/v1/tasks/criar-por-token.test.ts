/**
 * GET e POST /api/v1/tasks por Bearer `dsk_…` — o ERP cria "ligar para cobrar
 * parcela" ligada a um negócio e a um responsável, e lê o que pediu.
 *
 * Dois bancos em memória, porque a rota usa duas portas: o client do Supabase
 * (que aplica `eq`/`is`/`in`) e a porta SQL de `lib/db` (responsável, demanda e
 * linha do tempo), cuja resposta aqui obedece à organização do parâmetro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { portaDaAplicacao } from "@/lib/db";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  portaDaAplicacao: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");
const { audit } = await import("@/lib/audit");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const LEAD = "33333333-3333-4333-8333-333333333333";
const LEAD_B = "33333333-3333-4333-8333-333333333334";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONTATO_B = "22222222-2222-4222-8222-222222222223";
const VENDEDOR = "11111111-1111-4111-8111-111111111111";
const DE_OUTRA_ORG = "11111111-1111-4111-8111-111111111112";
const CHAVE = "5f0c6a52-6a3e-4b1d-9c1e-2f7a8b9c0d11";

type Linha = Record<string, unknown>;

function banco(tabelas: Record<string, Linha[]>) {
  const from = (nome: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let operacao: "select" | "update" | "insert" = "select";
    let patch: Linha = {};
    let novo: Linha = {};
    const linhas = (tabelas[nome] ??= []);
    const casa = () => linhas.filter((l) => filtros.every((f) => f(l)));
    const executa = (): { data: Linha[] | null; error: { code?: string; message: string } | null } => {
      if (operacao === "insert") {
        if (
          nome === "idempotency_keys" &&
          linhas.some((l) => l.organization_id === novo.organization_id && l.key === novo.key && l.endpoint === novo.endpoint)
        ) {
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        const linha = { id: `${nome}-${linhas.length + 1}`, created_at: "2026-11-13T12:00:00Z", ...novo };
        linhas.push(linha);
        return { data: [linha], error: null };
      }
      if (operacao === "update") {
        for (const l of casa()) Object.assign(l, patch);
        return { data: null, error: null };
      }
      return { data: casa(), error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      in: (c: string, v: unknown[]) => (filtros.push((l) => v.includes(l[c])), q),
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), q),
      gte: (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), q),
      lte: (c: string, v: string) => (filtros.push((l) => String(l[c]) <= v), q),
      order: () => q,
      limit: () => q,
      update: (p: Linha) => ((operacao = "update"), (patch = p), q),
      insert: (r: Linha) => ((operacao = "insert"), (novo = r), q),
      maybeSingle: async () => ({ data: executa().data?.[0] ?? null, error: null }),
      single: async () => {
        const r = executa();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (res: (v: unknown) => void) => res(executa()),
    };
    return q;
  };
  return { from } as never;
}

/** A porta SQL: responde só o que a organização do parâmetro enxerga. */
function portaSql(sqls: string[]) {
  const membros = new Map<string, string>([[VENDEDOR, ORG], [DE_OUTRA_ORG, OUTRA_ORG]]);
  return {
    queryOne: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("user_organizations")) return membros.get(String(params[1])) === params[0] ? { user_id: params[1] } : null;
      return null;
    }),
    query: vi.fn(async (sql: string) => {
      sqls.push(sql);
      return { rows: [], rowCount: 1 };
    }),
  } as never;
}

function req(body: unknown, headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest("http://localhost/api/v1/tasks", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}
function reqGet(query = "", headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest(`http://localhost/api/v1/tasks${query}`, { headers });
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
let sqls: string[];

beforeEach(() => {
  vi.clearAllMocks();
  sqls = [];
  tabelas = {
    crm_leads: [
      { id: LEAD, organization_id: ORG },
      { id: LEAD_B, organization_id: OUTRA_ORG },
    ],
    contacts: [
      { id: CONTATO, organization_id: ORG },
      { id: CONTATO_B, organization_id: OUTRA_ORG },
    ],
    crm_tasks: [],
    idempotency_keys: [],
  };
  vi.mocked(createAdminClient).mockReturnValue(banco(tabelas));
  vi.mocked(portaDaAplicacao).mockReturnValue(portaSql(sqls));
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

const corpo = { title: "Ligar para cobrar parcela", lead_id: LEAD, contact_id: CONTATO, assigned_to: VENDEDOR, priority: "high" as const };

describe("POST /api/v1/tasks — Bearer", () => {
  it("cria a tarefa na org do TOKEN, presa ao negócio e ao vendedor, sem created_by", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(201);
    expect(requireRole).not.toHaveBeenCalled();
    expect(tabelas.crm_tasks).toHaveLength(1);
    expect(tabelas.crm_tasks![0]).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      contact_id: CONTATO,
      assigned_to: VENDEDOR,
      created_by: null, // token não é pessoa: FK para auth.users
      priority: "high",
    });
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: "crm_task.created",
      organizationId: ORG,
      actorApiTokenId: "tok-1",
      actorUserId: null,
    });
    // O laço de retorno: a linha do tempo do negócio recebe `task_created`.
    expect(sqls.some((s) => s.includes("crm_lead_activities"))).toBe(true);
  });

  it("organization_id no corpo é ignorado: a org é a da LINHA DO TOKEN", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ ...corpo, organization_id: OUTRA_ORG }));

    // O schema não é `.strict()` (contrato da tela): o campo é descartado.
    expect(res.status).toBe(201);
    expect(tabelas.crm_tasks![0]!.organization_id).toBe(ORG);
  });

  it("negócio de OUTRA organização → 422, nada é criado", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ ...corpo, lead_id: LEAD_B }));

    expect(res.status).toBe(422);
    expect(tabelas.crm_tasks).toHaveLength(0);
  });

  it("contato de OUTRA organização → 422, nada é criado", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ ...corpo, contact_id: CONTATO_B }));

    expect(res.status).toBe(422);
    expect(tabelas.crm_tasks).toHaveLength(0);
  });

  it("responsável de OUTRA organização → 422, nada é criado", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ ...corpo, assigned_to: DE_OUTRA_ORG }));

    expect(res.status).toBe(422);
    expect(tabelas.crm_tasks).toHaveLength(0);
  });

  it("título vazio → 422", async () => {
    tokenOk();
    const { POST } = await import("./route");

    expect((await POST(req({ ...corpo, title: "  " }))).status).toBe(422);
    expect(tabelas.crm_tasks).toHaveLength(0);
  });

  it("sem mcp:write → 403; token inválido → 401; acima do teto → 429", async () => {
    const { POST } = await import("./route");

    tokenOk(["mcp:read"]);
    expect((await POST(req(corpo))).status).toBe(403);

    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    expect((await POST(req(corpo))).status).toBe(401);

    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await POST(req(corpo))).status).toBe(429);

    expect(tabelas.crm_tasks).toHaveLength(0);
  });

  it("Idempotency-Key: repetir devolve a MESMA tarefa e não cria a segunda", async () => {
    tokenOk();
    const { POST } = await import("./route");
    const headers = { authorization: "Bearer dsk_abc_def", "idempotency-key": CHAVE };

    const a = await POST(req(corpo, headers));
    const b = await POST(req(corpo, headers));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = ((await a.json()) as { data: { task: { id: string } } }).data.task.id;
    const idB = ((await b.json()) as { data: { task: { id: string } } }).data.task.id;
    expect(idB).toBe(idA);
    expect(tabelas.crm_tasks).toHaveLength(1);
  });

  it("Idempotency-Key com outro corpo → 409; chave que não é UUID → 400", async () => {
    tokenOk();
    const { POST } = await import("./route");
    const headers = { authorization: "Bearer dsk_abc_def", "idempotency-key": CHAVE };

    await POST(req(corpo, headers));
    const conflito = await POST(req({ ...corpo, title: "Outra" }, headers));
    const ruim = await POST(req(corpo, { authorization: "Bearer dsk_abc_def", "idempotency-key": "x" }));

    expect(conflito.status).toBe(409);
    expect(ruim.status).toBe(400);
    expect(tabelas.crm_tasks).toHaveLength(1);
  });
});

describe("POST /api/v1/tasks — sessão", () => {
  it("agent cria como a pessoa (created_by = usuário), pelo client do usuário", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: VENDEDOR, idioma: "pt-BR" },
      org: { orgId: ORG },
    } as never);
    vi.mocked(createClient).mockResolvedValue(banco(tabelas));
    const { POST } = await import("./route");

    const res = await POST(req(corpo, {}));

    expect(res.status).toBe(201);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(tabelas.crm_tasks![0]).toMatchObject({ organization_id: ORG, created_by: VENDEDOR });
  });
});

describe("GET /api/v1/tasks — Bearer", () => {
  const tarefa = (id: string, org: string, extra: Linha = {}) => ({
    id,
    organization_id: org,
    title: id,
    status: "pending",
    lead_id: null,
    assigned_to: null,
    ...extra,
  });

  beforeEach(() => {
    tabelas.crm_tasks = [
      tarefa("t-1", ORG, { lead_id: LEAD }),
      tarefa("t-2", ORG),
      tarefa("t-3", OUTRA_ORG),
    ];
  });

  it("com mcp:read lista SÓ as tarefas da org do token", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    const res = await GET(reqGet());

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { tasks: Array<{ id: string }> } };
    expect(data.tasks.map((t) => t.id).sort()).toEqual(["t-1", "t-2"]);
  });

  it("filtro por negócio continua dentro da org", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    const res = await GET(reqGet(`?lead_id=${LEAD_B}`));

    expect(((await res.json()) as { data: { tasks: unknown[] } }).data.tasks).toHaveLength(0);
  });

  it("assigned_to=me não vale para token → 422", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    expect((await GET(reqGet("?assigned_to=me"))).status).toBe(422);
  });

  it("escopo mcp:write sozinho não lê → 403; token inválido → 401", async () => {
    const { GET } = await import("./route");

    tokenOk(["mcp:write"]);
    expect((await GET(reqGet())).status).toBe(403);

    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    expect((await GET(reqGet())).status).toBe(401);
  });

  it("sessão viewer segue lendo pelo requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: VENDEDOR, idioma: "pt-BR" },
      org: { orgId: ORG },
    } as never);
    vi.mocked(createClient).mockResolvedValue(banco(tabelas));
    const { GET } = await import("./route");

    const res = await GET(reqGet("", {}));

    expect(res.status).toBe(200);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(((await res.json()) as { data: { tasks: unknown[] } }).data.tasks).toHaveLength(2);
  });
});
