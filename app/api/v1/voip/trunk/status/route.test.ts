// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function banco(linha: Record<string, unknown> | null) {
  const filtros: Array<[string, unknown]> = [];
  const q = {
    from: () => q,
    select: () => q,
    eq: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return q;
    },
    maybeSingle: async () => ({ data: linha, error: null }),
  };
  return { q, filtros };
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u" }, org: { orgId: ORG, role: "manager" } } as never);
});

describe("GET /api/v1/voip/trunk/status", () => {
  it("devolve o estado da organização, filtrado por organization_id", async () => {
    const { q, filtros } = banco({ state: "online", error: null, applied_at: "x", checked_at: "y" });
    vi.mocked(createClient).mockResolvedValue(q as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { state: string } }).data.state).toBe("online");
    expect(filtros).toContainEqual(["organization_id", ORG]);
  });

  it("sem conferência ainda: null", async () => {
    vi.mocked(createClient).mockResolvedValue(banco(null).q as never);
    const res = await GET();
    expect(((await res.json()) as { data: unknown }).data).toBeNull();
  });

  it("papel abaixo de manager recebe a resposta do requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    expect((await GET()).status).toBe(403);
  });
});
