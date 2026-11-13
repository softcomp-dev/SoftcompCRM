/**
 * GET /api/v1/team/assignable por Bearer `dsk_…` — o ERP lista quem pode ser
 * responsável por um negócio e casa o vendedor pelo e-mail.
 *
 * Prova: só membros ativos (não revogados), que aceitaram o convite, não viewer,
 * da org do TOKEN; `email` só no ramo de token; sessão sem e-mail e inalterada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type Linha = Record<string, unknown>;

const membros: Linha[] = [
  { user_id: "u-agent", organization_id: ORG, role: "agent", revoked_at: null, accepted_at: "2026-01-01", created_at: "1" },
  { user_id: "u-mgr", organization_id: ORG, role: "manager", revoked_at: null, accepted_at: "2026-01-01", created_at: "2" },
  { user_id: "u-viewer", organization_id: ORG, role: "viewer", revoked_at: null, accepted_at: "2026-01-01", created_at: "3" },
  { user_id: "u-revogado", organization_id: ORG, role: "agent", revoked_at: "2026-02-01", accepted_at: "2026-01-01", created_at: "4" },
  { user_id: "u-pendente", organization_id: ORG, role: "agent", revoked_at: null, accepted_at: null, created_at: "5" },
  { user_id: "u-alheio", organization_id: OUTRA, role: "agent", revoked_at: null, accepted_at: "2026-01-01", created_at: "6" },
];

/** Cliente em memória: aplica eq/is/neq/not e devolve `auth.admin.getUserById`. */
function admin() {
  return {
    from: () => {
      const filtros: Array<(l: Linha) => boolean> = [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
        is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
        not: (c: string, _op: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) !== v), q),
        order: async () => ({
          data: membros
            .filter((l) => filtros.every((f) => f(l)))
            .map(({ user_id, role }) => ({ user_id, role })),
          error: null,
        }),
      };
      return q;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { email: `${id}@erp.com`, user_metadata: { full_name: `Nome ${id}` } } },
        }),
      },
    },
  } as never;
}

function req(headers: Record<string, string> = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest("http://localhost/api/v1/team/assignable", { headers });
}

function tokenOk(scopes: string[], role: string = "viewer"): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: role as never,
    actor: { type: "api_token", id: "tok-1", role: role as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(admin());
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/v1/team/assignable — Bearer", () => {
  it("mcp:read + viewer → membros ativos que aceitaram, agent+, da org do token, com e-mail", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    const res = await GET(req());
    const corpo = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(corpo.data.map((m) => m.user_id)).toEqual(["u-agent", "u-mgr"]);
    expect(corpo.data[0]).toEqual({
      user_id: "u-agent",
      role: "agent",
      full_name: "Nome u-agent",
      email: "u-agent@erp.com",
    });
  });

  it("escopo errado → 403; token inválido → 401", async () => {
    tokenOk(["mcp:write"]);
    const { GET } = await import("./route");
    expect((await GET(req())).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await GET(req())).status).toBe(401);
  });
});

describe("GET /api/v1/team/assignable — sessão", () => {
  it("segue pelo requireRole('agent'), inclui pendente como antes e NÃO devolve e-mail", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-agent" },
      org: { orgId: ORG, role: "agent" },
    } as never);
    vi.mocked(createClient).mockResolvedValue(admin());
    const { GET } = await import("./route");

    const res = await GET(req({}));
    const corpo = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(corpo.data.map((m) => m.user_id)).toEqual(["u-agent", "u-mgr", "u-pendente"]);
    expect(corpo.data.every((m) => !("email" in m))).toBe(true);
  });

  it("leitura por token também conta no teto: acima dele, 429 com Retry-After", async () => {
    tokenOk(["mcp:read"]);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const { GET } = await import("./route");
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});
