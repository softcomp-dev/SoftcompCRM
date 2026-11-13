/**
 * POST /api/v1/leads/[id]/notes — nota na linha do tempo do negócio, por sessão
 * ou por Bearer `dsk_…`. Banco em memória que aplica `eq`; o recibo de
 * idempotência mora na mesma memória (índice único org + chave + endpoint).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { TIPO_DA_NOTA } from "./schema";

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
const LEAD = "33333333-3333-4333-8333-333333333333";
const LEAD_B = "33333333-3333-4333-8333-333333333334";
const CONTATO = "22222222-2222-4222-8222-222222222222";
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
        const linha = {
          id: `${nome}-${linhas.length + 1}`,
          performed_at: "2026-11-13T12:00:00.000Z",
          created_at: "2026-11-13T12:00:00.000Z",
          ...novo,
        };
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
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), q),
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

function req(body: unknown, id = LEAD, headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest(`http://localhost/api/v1/leads/${id}/notes`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}
const ctx = (id = LEAD) => ({ params: Promise.resolve({ id }) });

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

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    crm_leads: [
      { id: LEAD, organization_id: ORG, contact_id: CONTATO },
      { id: LEAD_B, organization_id: OUTRA_ORG, contact_id: null },
    ],
    crm_lead_activities: [],
    idempotency_keys: [],
  };
  vi.mocked(createAdminClient).mockReturnValue(banco(tabelas));
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/v1/leads/[id]/notes — Bearer", () => {
  it("grava a nota no tipo `note`, na org do TOKEN, com a autoria da integração", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ body: "NF 1234 emitida" }), ctx());

    expect(res.status).toBe(201);
    expect(requireRole).not.toHaveBeenCalled();
    const corpo = (await res.json()) as { data: { id: string; type: string; body: string; lead_id: string } };
    expect(corpo.data).toMatchObject({ type: TIPO_DA_NOTA, body: "NF 1234 emitida", lead_id: LEAD });
    expect(tabelas.crm_lead_activities).toHaveLength(1);
    expect(tabelas.crm_lead_activities![0]).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      contact_id: CONTATO,
      type: "note",
      reason: "NF 1234 emitida",
      actor_kind: "system",
      performed_by_user_id: null,
      payload: expect.objectContaining({ via: "token", api_token_id: "tok-1" }),
    });
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG,
      actorApiTokenId: "tok-1",
      resourceId: LEAD,
    });
  });

  it("occurred_at vira o momento da nota na linha do tempo", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ body: "Boleto vencido", occurred_at: "2026-11-01T10:00:00Z" }), ctx());

    expect(res.status).toBe(201);
    expect(tabelas.crm_lead_activities![0]).toMatchObject({ performed_at: "2026-11-01T10:00:00Z" });
  });

  it("occurred_at no futuro → 422", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ body: "x", occurred_at: "2999-01-01T00:00:00Z" }), ctx());

    expect(res.status).toBe(422);
    expect(tabelas.crm_lead_activities).toHaveLength(0);
  });

  it("corpo vazio, grande demais ou com campo estranho → 422, nada é gravado", async () => {
    tokenOk();
    const { POST } = await import("./route");

    for (const corpo of [{}, { body: "   " }, { body: "x".repeat(5001) }, { body: "ok", organization_id: OUTRA_ORG }]) {
      expect((await POST(req(corpo), ctx())).status).toBe(422);
    }
    expect(tabelas.crm_lead_activities).toHaveLength(0);
  });

  it("negócio de OUTRA organização → 404, nada é gravado", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ body: "x" }, LEAD_B), ctx(LEAD_B));

    expect(res.status).toBe(404);
    expect(tabelas.crm_lead_activities).toHaveLength(0);
  });

  it("sem mcp:write → 403; token inválido → 401; acima do teto → 429", async () => {
    const { POST } = await import("./route");

    tokenOk(["mcp:read"]);
    expect((await POST(req({ body: "x" }), ctx())).status).toBe(403);

    vi.mocked(validateBearerToken).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    expect((await POST(req({ body: "x" }), ctx())).status).toBe(401);

    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    expect((await POST(req({ body: "x" }), ctx())).status).toBe(429);

    expect(tabelas.crm_lead_activities).toHaveLength(0);
  });

  it("Idempotency-Key: repetir devolve a MESMA nota e não grava a segunda", async () => {
    tokenOk();
    const { POST } = await import("./route");
    const headers = { authorization: "Bearer dsk_abc_def", "idempotency-key": CHAVE };

    const a = await POST(req({ body: "NF 1234 emitida" }, LEAD, headers), ctx());
    const b = await POST(req({ body: "NF 1234 emitida" }, LEAD, headers), ctx());

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(((await b.json()) as { data: { id: string } }).data.id).toBe(((await a.json()) as { data: { id: string } }).data.id);
    expect(tabelas.crm_lead_activities).toHaveLength(1);
  });

  it("Idempotency-Key com outro corpo → 409; chave que não é UUID → 400", async () => {
    tokenOk();
    const { POST } = await import("./route");
    const headers = { authorization: "Bearer dsk_abc_def", "idempotency-key": CHAVE };

    await POST(req({ body: "A" }, LEAD, headers), ctx());
    const conflito = await POST(req({ body: "B" }, LEAD, headers), ctx());
    const ruim = await POST(req({ body: "A" }, LEAD, { authorization: "Bearer dsk_abc_def", "idempotency-key": "x" }), ctx());

    expect(conflito.status).toBe(409);
    expect(ruim.status).toBe(400);
    expect(tabelas.crm_lead_activities).toHaveLength(1);
  });
});

describe("POST /api/v1/leads/[id]/notes — sessão", () => {
  it("agent grava como a pessoa; o client é o do usuário", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "user-1", idioma: "pt-BR" },
      org: { orgId: ORG },
    } as never);
    vi.mocked(createClient).mockResolvedValue(banco(tabelas));
    const { POST } = await import("./route");

    const res = await POST(req({ body: "Cliente pediu retorno" }, LEAD, {}), ctx());

    expect(res.status).toBe(201);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(tabelas.crm_lead_activities![0]).toMatchObject({
      actor_kind: "user",
      performed_by_user_id: "user-1",
      payload: expect.objectContaining({ via: "session" }),
    });
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({ actorUserId: "user-1", actorApiTokenId: null });
  });

  it("viewer → 403 do requireRole, nada é gravado", async () => {
    const { fail } = await import("@/lib/api/wrappers");
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Requer role >= agent.", 403, {}),
    } as never);
    const { POST } = await import("./route");

    const res = await POST(req({ body: "x" }, LEAD, {}), ctx());

    expect(res.status).toBe(403);
    expect(tabelas.crm_lead_activities).toHaveLength(0);
  });
});
