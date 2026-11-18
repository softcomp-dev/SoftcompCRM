/**
 * GET /api/v1/ai/agents/:id/versions — agente que não existe nesta organização
 * é 404, não 200 com `[]`.
 *
 * A lista vazia não distinguia "agente sem versões" de "id errado ou de outra
 * organização", e o integrador que errou o id seguia achando que o agente
 * existia.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENTE = "22222222-2222-4222-8222-222222222222";
const ALHEIO = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;
const tabelas: Record<string, Linha[]> = {
  ai_agents: [
    { id: AGENTE, organization_id: ORG },
    { id: ALHEIO, organization_id: "99999999-9999-4999-8999-999999999999" },
  ],
  ai_agent_versions: [],
};

function consulta(tabela: string) {
  const filtros: Array<[string, unknown]> = [];
  const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return q;
    },
    order: async () => ({ data: linhas(), error: null }),
    maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
  };
  return q;
}

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    organizationId: ORG,
    actor: { type: "api_token", id: "tok" },
    supabase: { from: consulta },
    via: "token",
  })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));

const ler = (id: string) =>
  new NextRequest(`http://localhost/api/v1/ai/agents/${id}/versions`, {
    headers: { authorization: "Bearer dsk_a_b" },
  });

describe("GET /ai/agents/:id/versions", () => {
  it("agente desta organização sem versões → 200 com lista vazia", async () => {
    const { GET } = await import("./route");
    const res = await GET(ler(AGENTE), { params: Promise.resolve({ id: AGENTE }) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it("agente inexistente ou de outra organização → 404", async () => {
    const { GET } = await import("./route");
    for (const id of ["00000000-0000-4000-8000-000000000000", ALHEIO]) {
      const res = await GET(ler(id), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    }
  });
});
