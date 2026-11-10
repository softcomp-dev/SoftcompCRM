/**
 * Rotas da função SDR: interruptor, atribuição e permissões, contra um banco
 * em memória que APLICA os filtros (organização inclusive) — mede o efeito
 * da rota, não um mock que devolve o que o teste espera.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => false }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;

function fakeDb() {
  function consulta(tabela: string, op: "select" | "update", valores?: Linha) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const executar = () => {
      const achadas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      if (op === "update") for (const l of achadas) Object.assign(l, valores);
      return achadas.map((l) => ({ ...l }));
    };
    const q = {
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: string, v: null) => (filtros.push((l) => (l[c] ?? null) === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      not: (c: string) => (filtros.push((l) => (l[c] ?? null) !== null), q),
      filter: (c: string, _op: string, v: string) => (filtros.push((l) => JSON.stringify(l[c]) === v), q),
      select: () => q,
      order: () => q,
      maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res({ data: executar(), error: null }),
    };
    return q;
  }
  return {
    from: (tabela: string) => ({
      select: () => consulta(tabela, "select"),
      update: (v: Linha) => consulta(tabela, "update", v),
    }),
  };
}

function comoUsuario(userId: string, minimoPermitido: string[] = ["viewer", "agent", "manager", "admin"]) {
  vi.mocked(requireRole).mockImplementation((async (min: string) => {
    if (!minimoPermitido.includes(min)) {
      return { ok: false, response: Response.json({ error: { code: "forbidden_role" } }, { status: 403 }) };
    }
    return { ok: true, user: { id: userId, idioma: "pt-BR" }, org: { orgId: ORG } };
  }) as never);
}

function req(url: string, method = "GET", corpo?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const membro = (org: string, user_id: string, role: string, extra: Linha = {}) => ({
  organization_id: org,
  user_id,
  role,
  revoked_at: null,
  sdr_since: null,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    organizations: [
      { id: ORG, settings: { catalogo: { apresentacao: true } } },
      { id: OUTRA, settings: { sdr: { enabled: true } } },
    ],
    user_organizations: [
      membro(ORG, ADMIN, "admin"),
      membro(ORG, AGENTE, "agent"),
      membro(ORG, VIEWER, "viewer"),
      membro(OUTRA, AGENTE, "agent"),
    ],
  };
  vi.mocked(createAdminClient).mockImplementation(() => fakeDb() as never);
  comoUsuario(ADMIN);
});

const settings = () => import("../settings/sdr/route");
const assignments = () => import("./assignments/route");
const umAssignment = () => import("./assignments/[user_id]/route");
const permissions = () => import("./permissions/route");

async function ligar() {
  const { PATCH } = await settings();
  return PATCH(req("/api/v1/settings/sdr", "PATCH", { enabled: true }));
}

describe("interruptor (settings/sdr)", () => {
  it("nasce desligado e liga sem apagar outra configuração, auditando", async () => {
    const { GET } = await settings();
    expect((await (await GET(req("/api/v1/settings/sdr"))).json()).data).toEqual({ enabled: false });

    const r = await ligar();
    expect(r.status).toBe(200);
    expect(tabelas.organizations![0]!.settings).toEqual({ catalogo: { apresentacao: true }, sdr: { enabled: true } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "sdr.settings_changed", metadata: { enabled: true } }));
  });

  it("repetir o mesmo valor não escreve nem audita", async () => {
    await ligar();
    vi.mocked(audit).mockClear();
    expect((await ligar()).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("recusa corpo inválido", async () => {
    const { PATCH } = await settings();
    expect((await PATCH(req("/api/v1/settings/sdr", "PATCH", { enabled: "sim" }))).status).toBe(422);
  });
});

describe("atribuição (sdr/assignments)", () => {
  it("com a função desligada, 409 sdr_disabled e nada é escrito", async () => {
    const { POST } = await assignments();
    const r = await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("sdr_disabled");
    expect(tabelas.user_organizations!.every((l) => l.sdr_since === null)).toBe(true);
  });

  it("marca um agent (201), só nesta organização, e audita uma vez", async () => {
    await ligar();
    vi.mocked(audit).mockClear();
    const { POST } = await assignments();

    const r = await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }));
    expect(r.status).toBe(201);
    expect((await r.json()).data).toMatchObject({ user_id: AGENTE, active: true, inactive_reason: null });
    const [nesta, naOutra] = tabelas.user_organizations!.filter((l) => l.user_id === AGENTE);
    expect(nesta!.sdr_since).not.toBeNull();
    expect(naOutra!.sdr_since).toBeNull();

    // idempotente: 200, sem segunda auditoria
    const de_novo = await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }));
    expect(de_novo.status).toBe(200);
    expect(vi.mocked(audit).mock.calls.filter(([a]) => a.action === "sdr.assigned")).toHaveLength(1);
  });

  it("recusa viewer com sdr_role_ineligible e o papel mínimo", async () => {
    await ligar();
    const { POST } = await assignments();
    const r = await POST(req("/api/v1/sdr/assignments", "POST", { user_id: VIEWER }));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatchObject({
      code: "sdr_role_ineligible",
      details: { role: "viewer", minimum_role: "agent" },
    });
  });

  it("membro de outra organização é 404", async () => {
    await ligar();
    tabelas.user_organizations = tabelas.user_organizations!.filter((l) => l.organization_id !== ORG || l.user_id !== AGENTE);
    const { POST } = await assignments();
    expect((await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }))).status).toBe(404);
  });

  it("só admin marca", async () => {
    await ligar();
    comoUsuario(AGENTE, ["viewer", "agent", "manager"]);
    const { POST } = await assignments();
    expect((await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }))).status).toBe(403);
  });

  it("a lista mostra o SDR rebaixado a viewer como inativo", async () => {
    await ligar();
    const { POST, GET } = await assignments();
    await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }));
    tabelas.user_organizations!.find((l) => l.organization_id === ORG && l.user_id === AGENTE)!.role = "viewer";

    const corpo = await (await GET(req("/api/v1/sdr/assignments"))).json();
    expect(corpo.meta).toEqual({ total: 1 });
    expect(corpo.data[0]).toMatchObject({ user_id: AGENTE, active: false, inactive_reason: "role_below_minimum" });
  });

  it("desmarca, de forma idempotente, auditando só a primeira", async () => {
    await ligar();
    const { POST } = await assignments();
    await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }));
    vi.mocked(audit).mockClear();

    const { DELETE } = await umAssignment();
    const ctx = { params: Promise.resolve({ user_id: AGENTE }) };
    expect((await DELETE(req(`/api/v1/sdr/assignments/${AGENTE}`, "DELETE"), ctx)).status).toBe(200);
    expect((await DELETE(req(`/api/v1/sdr/assignments/${AGENTE}`, "DELETE"), ctx)).status).toBe(200);
    expect(vi.mocked(audit).mock.calls.map(([a]) => a.action)).toEqual(["sdr.unassigned"]);
  });
});

describe("permissões (sdr/permissions)", () => {
  it("desligar a função tira as permissões e preserva a marca; religar devolve", async () => {
    await ligar();
    const { POST } = await assignments();
    await POST(req("/api/v1/sdr/assignments", "POST", { user_id: AGENTE }));

    comoUsuario(AGENTE);
    const { GET } = await permissions();
    const ligada = (await (await GET(req("/api/v1/sdr/permissions"))).json()).data;
    // agent: trabalha o lead, mas não vê a lista da equipe (isso é manager+)
    expect(ligada.permissions).toEqual(["sdr.leads.prospect", "sdr.leads.qualify", "sdr.leads.handoff"]);

    comoUsuario(ADMIN);
    const { PATCH } = await settings();
    await PATCH(req("/api/v1/settings/sdr", "PATCH", { enabled: false }));

    comoUsuario(AGENTE);
    const desligada = (await (await GET(req("/api/v1/sdr/permissions"))).json()).data;
    expect(desligada.sdr).toMatchObject({ assigned: true, active: false, inactive_reason: "feature_disabled" });
    expect(desligada.permissions).toEqual([]);

    comoUsuario(ADMIN);
    await ligar();
    comoUsuario(AGENTE);
    expect((await (await GET(req("/api/v1/sdr/permissions"))).json()).data.sdr.active).toBe(true);
  });

  it("ver as permissões de outra pessoa exige manager", async () => {
    comoUsuario(AGENTE, ["viewer", "agent"]);
    const { GET } = await permissions();
    expect((await GET(req(`/api/v1/sdr/permissions?user_id=${ADMIN}`))).status).toBe(403);
    expect((await GET(req("/api/v1/sdr/permissions"))).status).toBe(200);
  });

  it("parâmetro desconhecido ou user_id inválido é 422", async () => {
    const { GET } = await permissions();
    expect((await GET(req("/api/v1/sdr/permissions?user_id=x"))).status).toBe(422);
    expect((await GET(req("/api/v1/sdr/permissions?org=1"))).status).toBe(422);
  });
});
