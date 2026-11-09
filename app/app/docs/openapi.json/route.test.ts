/**
 * GET /app/docs/openapi.json — só para quem está logado; com a marca da
 * organização e o endereço público da instalação.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { isPublicPath } from "@/lib/auth/public-paths";
import { marcaDaSaida } from "@/lib/branding/saida";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn() }));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(marcaDaSaida).mockResolvedValue({ nome: "Minha Marca" } as never);
});

describe("GET /app/docs/openapi.json", () => {
  it("logado → 200, especificação com a marca da organização ativa", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "viewer" },
    } as never);
    const { GET } = await import("./route");

    const res = await GET();

    expect(res.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("viewer");
    expect(vi.mocked(marcaDaSaida).mock.calls[0]?.[0]).toBe(ORG);
    const spec = (await res.json()) as { info: { title: string }; paths: Record<string, unknown> };
    expect(spec.info.title).toBe("Minha Marca — API para integrações");
    expect(spec.paths["/api/v1/leads"]).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("sem sessão → repassa a recusa de requireRole e não lê nada", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    } as never);
    const { GET } = await import("./route");

    const res = await GET();

    expect(res.status).toBe(401);
    expect(marcaDaSaida).not.toHaveBeenCalled();
  });

  it("não está em PUBLIC_PATHS: o proxy exige sessão antes da rota", () => {
    expect(isPublicPath("/app/docs/openapi.json")).toBe(false);
    expect(isPublicPath("/app/docs")).toBe(false);
    expect(isPublicPath("/docs")).toBe(false);
  });
});
