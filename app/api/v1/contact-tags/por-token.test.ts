/**
 * GET /api/v1/contact-tags por Bearer `dsk_…` — o ERP lê o vocabulário de etiquetas.
 *
 * Prova: token com mcp:read lê só a org do TOKEN (a consulta e a RPC filtram por
 * ela); sem o escopo 403; token inválido 401; e a sessão segue como sempre.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type Contato = { organization_id: string; tags: string[] };

/** `contacts` em memória: aplica o `eq("organization_id")` e devolve só as tags. */
function bancoDeContatos(contatos: Contato[]) {
  return {
    from: () => {
      let org: unknown;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (_c: string, v: unknown) => ((org = v), q),
        neq: () => q,
        order: () => q,
        limit: async () => ({ data: contatos.filter((c) => c.organization_id === org), error: null }),
      };
      return q;
    },
  } as never;
}

const contatos: Contato[] = [
  { organization_id: ORG, tags: ["VIP", "vip ", "cliente"] },
  { organization_id: ORG, tags: ["vip"] },
  { organization_id: OUTRA_ORG, tags: ["segredo-da-outra-org"] },
];

function req(headers: Record<string, string> = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest("http://localhost/api/v1/contact-tags", { headers });
}

function tokenOk(scopes: string[] = ["mcp:read"], role = "viewer"): void {
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
  vi.mocked(createAdminClient).mockReturnValue(bancoDeContatos(contatos));
  vi.mocked(createClient).mockResolvedValue(bancoDeContatos(contatos));
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/v1/contact-tags — Bearer", () => {
  it("token viewer com mcp:read → 200 com as etiquetas SÓ da org do token, normalizadas e por uso", async () => {
    tokenOk();
    const { GET } = await import("./route");

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    const { data } = (await res.json()) as { data: string[] };
    expect(data).toEqual(["vip", "cliente"]);
    expect(data).not.toContain("segredo-da-outra-org");
  });

  it("a busca passa a org do TOKEN para a RPC", async () => {
    tokenOk();
    const rpc = vi.fn(async () => ({ data: null, error: { message: "x" } }));
    vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
    const { GET } = await import("./route");

    await GET(
      new NextRequest("http://localhost/api/v1/contact-tags?busca=vi", {
        headers: { authorization: "Bearer dsk_abc_def" },
      }),
    );

    expect(rpc).toHaveBeenCalledWith("fn_vocabulario_de_tags_pagina", expect.objectContaining({ p_org: ORG }));
  });

  it("token sem mcp:read → 403; token inválido → 401", async () => {
    tokenOk(["mcp:write"]);
    const { GET } = await import("./route");
    expect((await GET(req())).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await GET(req())).status).toBe(401);
  });

  it("sessão (cookie) segue por requireRole('viewer') e pelo client da sessão", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "viewer" },
    } as never);
    const { GET } = await import("./route");

    const res = await GET(req({}));

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});
