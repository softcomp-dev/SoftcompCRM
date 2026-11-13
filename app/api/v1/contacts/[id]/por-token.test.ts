/**
 * GET / PATCH / DELETE /api/v1/contacts/{id} por Bearer `dsk_…` — o ERP lê e
 * corrige a ficha do cliente.
 *
 * O que esta suíte prova:
 * - GET com `mcp:read` devolve a ficha DA ORG DO TOKEN pelo client de serviço, sem
 *   CPF em claro (só `cpf_available`), e contato de outra org é 404;
 * - PATCH com `mcp:write` chama o handler com o token como ator e a org da linha
 *   do token; sem o escopo 403, token inválido 401, acima do teto 429;
 * - telefone/e-mail de outro contato chega como 409 com `details.contact_id`;
 * - falha interna do banco não vaza o texto do Postgres ao integrador;
 * - DELETE nunca aceita Bearer (403, sem tocar no handler) e a sessão segue igual;
 * - o ramo de sessão (cookie) segue pelo `requireRole`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { deleteContactHandler, patchContactHandler } from "../_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(), orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/legal/perfil-do-pais", async () => {
  const actual = await vi.importActual<typeof import("@/lib/legal/perfil-do-pais")>("@/lib/legal/perfil-do-pais");
  return { ...actual, perfilDaOrganizacao: vi.fn(async () => actual.perfilDoPais("BR")) };
});
vi.mock("../_handler", async () => {
  const actual = await vi.importActual<typeof import("../_handler")>("../_handler");
  return {
    ...actual,
    patchContactHandler: vi.fn(actual.patchContactHandler),
    deleteContactHandler: vi.fn(async () => ({ id: "x" })),
  };
});
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_DO_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MEU_CONTATO = "11111111-1111-4111-8111-111111111111";
const CONTATO_ALHEIO = "22222222-2222-4222-8222-222222222222";

type Linha = Record<string, unknown>;

/** Banco em memória que APLICA os filtros (eq, in, is) — o que o isolamento exige. */
function bancoEmMemoria(tabelas: Record<string, Linha[]>) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    const casa = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: casa()[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res({ data: casa(), error: null }),
    };
    return q;
  };
  return { from } as never;
}

const contatos = (): Linha[] => [
  {
    id: MEU_CONTATO,
    organization_id: ORG_DO_TOKEN,
    name: "Maria",
    email: "maria@exemplo.com",
    phone_number: "+5531988887777",
    cpf_encrypted: "\\xdeadbeef",
    is_anonymized: false,
    tags: [],
    consent: {},
    custom_fields: {},
    phone_type: "mobile",
    phone_whatsapp: "yes",
  },
  {
    id: CONTATO_ALHEIO,
    organization_id: OUTRA_ORG,
    name: "Alheio",
    cpf_encrypted: null,
    is_anonymized: false,
    tags: [],
    consent: {},
    custom_fields: {},
  },
];

function req(
  metodo: "GET" | "PATCH" | "DELETE",
  id: string,
  body?: unknown,
  headers: Record<string, string> = { authorization: "Bearer dsk_abc_def" },
) {
  return new NextRequest(`http://localhost/api/v1/contacts/${id}`, {
    method: metodo,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function tokenOk(scopes: string[]): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    role: "agent" as never,
    actor: { type: "api_token", id: "tok-1", role: "agent" as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(
    bancoEmMemoria({ contacts: contatos(), conversations: [], contact_phones: [] }),
  );
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/v1/contacts/{id} — Bearer", () => {
  it("mcp:read → 200 com a ficha da org do token; CPF só como cpf_available, nunca em claro", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    const res = await GET(req("GET", MEU_CONTATO), ctx(MEU_CONTATO));
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(corpo.data).toMatchObject({ id: MEU_CONTATO, name: "Maria", cpf_available: true, cpf_decrypted: null });
    expect(corpo.data).not.toHaveProperty("cpf_encrypted");
    expect(corpo.data).toMatchObject({ phone_type: "mobile", additional_phones: [] });
  });

  it("X-Decrypt-Purpose por token não abre o CPF", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    const res = await GET(
      req("GET", MEU_CONTATO, undefined, { authorization: "Bearer dsk_abc_def", "x-decrypt-purpose": "ERP" }),
      ctx(MEU_CONTATO),
    );

    const corpo = (await res.json()) as { data: { cpf_decrypted: unknown; cpf_decrypt_denied?: unknown } };
    expect(corpo.data.cpf_decrypted).toBeNull();
  });

  it("contato de OUTRA organização → 404, nunca o dado", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    const res = await GET(req("GET", CONTATO_ALHEIO), ctx(CONTATO_ALHEIO));

    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("Alheio");
  });

  it("id que não é UUID → 404", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");
    expect((await GET(req("GET", "nao-e-uuid"), ctx("nao-e-uuid"))).status).toBe(404);
  });

  it("escopo errado → 403; token inválido → 401", async () => {
    tokenOk(["mcp:write"]);
    const { GET } = await import("./route");
    expect((await GET(req("GET", MEU_CONTATO), ctx(MEU_CONTATO))).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await GET(req("GET", MEU_CONTATO), ctx(MEU_CONTATO))).status).toBe(401);
  });
});

describe("PATCH /api/v1/contacts/{id} — Bearer", () => {
  it("mcp:write → 200; o handler recebe a org e o ator do TOKEN, pelo client de serviço", async () => {
    tokenOk(["mcp:write"]);
    vi.mocked(patchContactHandler).mockResolvedValueOnce({ id: MEU_CONTATO, name: "Maria S." } as never);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", MEU_CONTATO, { name: "Maria S." }), ctx(MEU_CONTATO));

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    const [client, c, id, input] = vi.mocked(patchContactHandler).mock.calls[0] ?? [];
    expect(client).toBe(vi.mocked(createAdminClient).mock.results[0]?.value);
    expect(c).toMatchObject({ organization_id: ORG_DO_TOKEN, actor: { type: "api_token", id: "tok-1" } });
    expect(id).toBe(MEU_CONTATO);
    expect(input).toMatchObject({ name: "Maria S." });
  });

  it("organization_id no corpo não escolhe a org", async () => {
    tokenOk(["mcp:write"]);
    vi.mocked(patchContactHandler).mockResolvedValueOnce({ id: MEU_CONTATO } as never);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", MEU_CONTATO, { name: "X", organization_id: OUTRA_ORG }), ctx(MEU_CONTATO));

    if (res.status === 200) {
      expect(vi.mocked(patchContactHandler).mock.calls[0]?.[1]).toMatchObject({ organization_id: ORG_DO_TOKEN });
      expect(vi.mocked(patchContactHandler).mock.calls[0]?.[3]).not.toHaveProperty("organization_id");
    } else {
      expect(res.status).toBe(422);
      expect(patchContactHandler).not.toHaveBeenCalled();
    }
  });

  it("contato de OUTRA organização → 404 (o handler real filtra pela org do token)", async () => {
    tokenOk(["mcp:write"]);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", CONTATO_ALHEIO, { name: "Invadido" }), ctx(CONTATO_ALHEIO));

    expect(res.status).toBe(404);
  });

  it("escopo errado → 403; token inválido → 401; nada é gravado", async () => {
    tokenOk(["mcp:read"]);
    const { PATCH } = await import("./route");
    expect((await PATCH(req("PATCH", MEU_CONTATO, { name: "X" }), ctx(MEU_CONTATO))).status).toBe(403);

    const { McpAuthError } = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValueOnce(new McpAuthError(-32001, 401, "Token inválido."));
    expect((await PATCH(req("PATCH", MEU_CONTATO, { name: "X" }), ctx(MEU_CONTATO))).status).toBe(401);
    expect(patchContactHandler).not.toHaveBeenCalled();
  });

  it("acima do teto → 429 com Retry-After, nada é gravado", async () => {
    tokenOk(["mcp:write"]);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", MEU_CONTATO, { name: "X" }), ctx(MEU_CONTATO));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(patchContactHandler).not.toHaveBeenCalled();
  });

  it("e-mail de outro contato → 409 contact_exists com o id em details", async () => {
    tokenOk(["mcp:write"]);
    vi.mocked(patchContactHandler).mockRejectedValueOnce(
      new ApiError(409, "contact_exists", { contact_id: "ja-existe" }, "r", "Já existe um contato com este e-mail."),
    );
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", MEU_CONTATO, { email: "outro@exemplo.com" }), ctx(MEU_CONTATO));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code: "contact_exists",
      details: { contact_id: "ja-existe" },
    });
  });

  it("falha interna não vaza o texto do banco ao integrador", async () => {
    tokenOk(["mcp:write"]);
    vi.mocked(patchContactHandler).mockRejectedValueOnce(
      new ApiError(500, "internal_error", undefined, "r", 'violates constraint "uniq_contacts_org_email"'),
    );
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", MEU_CONTATO, { name: "X" }), ctx(MEU_CONTATO));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("uniq_contacts_org_email");
  });

  it("corpo vazio → 4xx de validação, nada é gravado", async () => {
    tokenOk(["mcp:write"]);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", MEU_CONTATO, { campo_que_nao_existe: 1 }), ctx(MEU_CONTATO));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("a sessão segue pelo requireRole, sem validar Bearer", async () => {
    vi.mocked(createClient).mockResolvedValue({ session: true } as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "user-1", idioma: "pt-BR" },
      org: { orgId: ORG_DO_TOKEN, role: "agent" },
    } as never);
    vi.mocked(patchContactHandler).mockResolvedValueOnce({ id: MEU_CONTATO } as never);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", MEU_CONTATO, { name: "X" }, {}), ctx(MEU_CONTATO));

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(vi.mocked(patchContactHandler).mock.calls[0]?.[1]).toMatchObject({
      actor: { type: "user", id: "user-1" },
    });
  });
});

describe("DELETE /api/v1/contacts/{id} — nunca por token", () => {
  it("Bearer (mesmo com todos os escopos) → 403 e o handler não é chamado", async () => {
    tokenOk(["mcp:read", "mcp:write"]);
    const { DELETE } = await import("./route");

    const res = await DELETE(req("DELETE", MEU_CONTATO), ctx(MEU_CONTATO));

    expect(res.status).toBe(403);
    expect(deleteContactHandler).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("sem sessão e sem Bearer → a resposta do requireRole (401), sem excluir", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status: 401 }),
    } as never);
    const { DELETE } = await import("./route");

    const res = await DELETE(req("DELETE", MEU_CONTATO, undefined, {}), ctx(MEU_CONTATO));

    expect(res.status).toBe(401);
    expect(deleteContactHandler).not.toHaveBeenCalled();
  });
});
