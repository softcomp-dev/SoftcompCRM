/**
 * POST /api/v1/contacts por Bearer `dsk_…` — o ERP cria o cliente antes do card.
 *
 * O que esta suíte prova:
 * - token com `mcp:write` cria (201) pelo client de serviço, na org do TOKEN;
 * - `organization_id` no corpo é recusado (o corpo é estrito) e nunca escolhe a org;
 * - sem o escopo, 403; token inválido, 401; acima do teto, 429;
 * - contato repetido chega como 409 com o id do que já existe;
 * - `Idempotency-Key` repetida não cria o segundo;
 * - a sessão (cookie) segue pelo caminho de sempre.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { createContactHandler } from "./_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/legal/perfil-do-pais", async () => {
  const actual = await vi.importActual<typeof import("@/lib/legal/perfil-do-pais")>("@/lib/legal/perfil-do-pais");
  return { ...actual, perfilDaOrganizacao: vi.fn(async () => actual.perfilDoPais("BR")) };
});
vi.mock("./_handler", async () => {
  const actual = await vi.importActual<typeof import("./_handler")>("./_handler");
  return {
    ...actual,
    createContactHandler: vi.fn(async () => ({ contact: { id: "contato-novo", name: "Maria" }, action: "created" })),
  };
});
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_DO_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CHAVE = "5f0c6a52-6a3e-4b1d-9c1e-2f7a8b9c0d11";

const corpo = { name: "Maria Exemplo", phone_number: "+5531988887777", email: "maria@exemplo.com" };

function req(body: unknown, headers: Record<string, string> = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest("http://localhost/api/v1/contacts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenOk(scopes: string[] = ["mcp:write"]): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    role: "agent" as never,
    actor: { type: "api_token", id: "tok-1", role: "agent" as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

/** `idempotency_keys` em memória, com o índice único (org + chave + endpoint). */
function bancoComRecibos() {
  type Linha = Record<string, unknown>;
  const linhas: Linha[] = [];
  const from = () => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let patch: Linha | null = null;
    const casa = () => linhas.filter((l) => filtros.every((f) => f(l)));
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), q),
      insert: async (linha: Linha) => {
        if (linhas.some((l) => l.organization_id === linha.organization_id && l.key === linha.key && l.endpoint === linha.endpoint)) {
          return { error: { code: "23505" } };
        }
        linhas.push({ id: `recibo-${linhas.length}`, ...linha });
        return { error: null };
      },
      update: (p: Linha) => ((patch = p), q),
      maybeSingle: async () => ({ data: casa()[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => {
        if (patch) for (const l of casa()) Object.assign(l, patch);
        res({ data: null, error: null });
      },
    };
    return q;
  };
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue({ admin: true } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/v1/contacts — Bearer", () => {
  it("token com mcp:write → 201, contato criado na org do TOKEN pelo client de serviço", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(201);
    expect(requireRole).not.toHaveBeenCalled();
    const [client, ctx, input] = vi.mocked(createContactHandler).mock.calls[0] ?? [];
    expect(client).toEqual({ admin: true });
    expect(ctx).toMatchObject({ organization_id: ORG_DO_TOKEN, actor: { type: "api_token", id: "tok-1" } });
    expect(input).toMatchObject({ name: "Maria Exemplo", phone_number: "+5531988887777" });
    expect(((await res.json()) as { data: { contact: { id: string } } }).data.contact.id).toBe("contato-novo");
  });

  it("organization_id no corpo não escolhe a org: o corpo é estrito e a org é a do token", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ ...corpo, organization_id: OUTRA_ORG }));

    if (res.status === 201) {
      expect(vi.mocked(createContactHandler).mock.calls[0]?.[1]).toMatchObject({ organization_id: ORG_DO_TOKEN });
    } else {
      expect(res.status).toBe(422);
      expect(createContactHandler).not.toHaveBeenCalled();
    }
  });

  it("token sem mcp:write → 403; token inválido → 401; nada é criado", async () => {
    tokenOk(["mcp:read"]);
    const { POST } = await import("./route");
    expect((await POST(req(corpo))).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await POST(req(corpo))).status).toBe(401);
    expect(createContactHandler).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, nada é criado", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(createContactHandler).not.toHaveBeenCalled();
  });

  it("contato repetido → 409 contact_exists com o id do que já existe", async () => {
    tokenOk();
    vi.mocked(createContactHandler).mockRejectedValueOnce(
      new ApiError(409, "contact_exists", { contact_id: "ja-existe" }, "r", "Já existe um contato com este telefone."),
    );
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code: "contact_exists",
      details: { contact_id: "ja-existe" },
    });
  });

  it("a mesma Idempotency-Key com o mesmo corpo não cria o segundo", async () => {
    tokenOk();
    vi.mocked(createAdminClient).mockReturnValue(bancoComRecibos());
    const { POST } = await import("./route");
    const comChave = { authorization: "Bearer dsk_abc_def", "idempotency-key": CHAVE };

    expect((await POST(req(corpo, comChave))).status).toBe(201);
    expect((await POST(req(corpo, comChave))).status).toBe(201);
    expect(createContactHandler).toHaveBeenCalledTimes(1);
  });

  it("libera /api/v1/contacts no proxy, e não os irmãos", () => {
    expect(isPublicPath("/api/v1/contacts")).toBe(true);
    expect(isPublicPath("/api/v1/contacts/import")).toBe(false);
  });
});
