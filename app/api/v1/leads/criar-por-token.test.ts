/**
 * POST /api/v1/leads por Bearer `dsk_…` — criar card a partir de um ERP.
 *
 * O ramo do token faz o que a tool MCP `crm_create_lead` faz, pelo mesmo
 * `createLeadHandler`. O que esta suíte prova:
 *
 * - token com `mcp:write` cria (201); sem o escopo, 403; inválido, 401;
 * - a org é a da LINHA DO TOKEN — `organization_id` no corpo não muda nada;
 * - o client é o admin (o handler filtra a org), e a sessão nem é consultada;
 * - o aviso de negócio aberto duplicado (#1751) vale também por token;
 * - o teto por token barra o laço (429);
 * - `/api/v1/leads` passa pelo proxy sem cookie, e os irmãos literais não.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { negocioAbertoExistente } from "@/lib/leads/negocio-aberto-duplicado";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

import { createLeadHandler } from "./_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("./_handler", () => ({
  createLeadHandler: vi.fn(async () => ({ id: "lead-novo", title: "Pedido 12345" })),
}));
vi.mock("@/lib/leads/negocio-aberto-duplicado", async () => {
  const actual = await vi.importActual<typeof import("@/lib/leads/negocio-aberto-duplicado")>(
    "@/lib/leads/negocio-aberto-duplicado",
  );
  return { ...actual, negocioAbertoExistente: vi.fn(async () => null) };
});
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_DO_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const ADMIN = { admin: true } as never;

const corpo = {
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  title: "Pedido 12345 - Maria",
  contact_id: CONTATO,
  value_cents: 150000,
  source: "erp",
};

function req(body: unknown, headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest("http://localhost/api/v1/leads", {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(ADMIN);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/v1/leads — Bearer", () => {
  it("token com mcp:write → 201, card criado na org do TOKEN pelo client admin", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(201);
    expect(requireRole).not.toHaveBeenCalled();
    const [client, ctx, input] = vi.mocked(createLeadHandler).mock.calls[0] ?? [];
    expect(client).toBe(ADMIN);
    expect(ctx).toMatchObject({
      organization_id: ORG_DO_TOKEN,
      actor: { type: "api_token", id: "tok-1" },
    });
    expect(input).toMatchObject({ pipeline_id: FUNIL, stage_id: ETAPA, value_cents: 150000 });
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("lead-novo");
  });

  it("organization_id no corpo é ignorado: a org é a da LINHA DO TOKEN", async () => {
    tokenOk();
    const { POST } = await import("./route");

    await POST(req({ ...corpo, organization_id: OUTRA_ORG }));

    expect(vi.mocked(createLeadHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_DO_TOKEN,
    });
  });

  it("token sem mcp:write → 403, nada é criado", async () => {
    tokenOk(["mcp:read"]);
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(403);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("token inválido → 401, nada é criado", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(401);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("corpo sem stage_id → 422, nada é criado", async () => {
    tokenOk();
    const { POST } = await import("./route");
    const { stage_id: _semEtapa, ...semEtapa } = corpo;

    const res = await POST(req(semEtapa));

    expect(res.status).toBe(422);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, nada é criado", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("cliente com negócio aberto no funil → cria e avisa em meta (#1751), consultando a org do token", async () => {
    tokenOk();
    vi.mocked(negocioAbertoExistente).mockResolvedValueOnce({
      id: "lead-antigo",
      title: "Pedido anterior",
    } as never);
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(201);
    expect(vi.mocked(negocioAbertoExistente).mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG_DO_TOKEN,
      contactId: CONTATO,
      pipelineId: FUNIL,
    });
    const body = (await res.json()) as { meta?: { avisos?: string[] } };
    expect(body.meta?.avisos).toHaveLength(1);
  });
});

describe("POST /api/v1/leads — alcançável sem cookie (proxy)", () => {
  it("libera /api/v1/leads", () => {
    expect(isPublicPath("/api/v1/leads")).toBe(true);
  });

  it("NÃO libera os irmãos literais, que não têm Bearer", () => {
    expect(isPublicPath("/api/v1/leads/bulk")).toBe(false);
    expect(isPublicPath("/api/v1/leads/import")).toBe(false);
    expect(isPublicPath("/api/v1/leads/at-risk")).toBe(false);
  });
});
