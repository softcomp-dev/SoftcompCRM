/**
 * GET /api/v1/pipelines e GET /api/v1/pipelines/[id]/stages por Bearer `dsk_…`.
 *
 * O consumidor real é um ERP: para criar card por `POST /api/v1/leads` ele
 * precisa de `pipeline_id` e `stage_id`, e até aqui a única porta era a tool
 * MCP. O que esta suíte prova:
 *
 * - token com `mcp:read` lê; sem o escopo, 403; token inválido, 401;
 * - o papel exigido do token é o da tool MCP (`agent`), não o da tela (`manager`);
 * - a org é a da LINHA DO TOKEN, e a consulta de etapas a filtra explicitamente
 *   (o client do token ignora a RLS);
 * - os dois paths passam pelo proxy sem cookie, e os irmãos literais não.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

import { listPipelinesHandler } from "./_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("./_handler", () => ({ listPipelinesHandler: vi.fn(async () => ({ pipelines: [] })) }));
vi.mock("@/lib/followup/fluxos-da-etapa", () => ({
  carregaFluxosPorEtapa: vi.fn(async () => null),
  anexaFluxos: (linhas: unknown[]) => linhas,
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_DO_TOKEN = "22222222-2222-4222-8222-222222222222";
const PIPE = "44444444-4444-4444-8444-444444444444";
const BEARER = { authorization: "Bearer dsk_abc_def" };

/** Client falso que registra os filtros `.eq()` da consulta de etapas. */
function adminQueRegistra() {
  const filtros: Array<[string, unknown]> = [];
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return consulta;
    },
    order: async () => ({ data: [{ id: "e1", name: "Novo" }], error: null }),
  };
  const client = { from: () => consulta };
  return { client, filtros };
}

function tokenOk(scopes: string[] = ["mcp:read"]): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    role: "agent" as never,
    actor: { type: "api_token", id: "tok-1", role: "agent" as never },
    apiTokenId: "tok-1",
    scopes,
  });
}

const ctxEtapas = { params: Promise.resolve({ id: PIPE }) };
const reqFunis = (headers?: HeadersInit) =>
  new NextRequest("http://localhost/api/v1/pipelines", { headers });
const reqEtapas = (headers?: HeadersInit) =>
  new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/stages`, { headers });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("GET /api/v1/pipelines — Bearer", () => {
  it("token agent com mcp:read → 200, org e client do TOKEN, sem tocar a sessão", async () => {
    tokenOk();
    const admin = { admin: true } as never;
    vi.mocked(createAdminClient).mockReturnValue(admin);
    const { GET } = await import("./route");

    const res = await GET(reqFunis(BEARER));

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(vi.mocked(listPipelinesHandler).mock.calls[0]?.[0]).toBe(admin);
    expect(vi.mocked(listPipelinesHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_DO_TOKEN,
      actor: { type: "api_token", id: "tok-1" },
    });
  });

  it("token sem mcp:read → 403, handler não roda", async () => {
    tokenOk(["mcp:write"]);
    const { GET } = await import("./route");

    const res = await GET(reqFunis(BEARER));

    expect(res.status).toBe(403);
    expect(listPipelinesHandler).not.toHaveBeenCalled();
  });

  it("token inválido → 401, handler não roda", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const { GET } = await import("./route");

    const res = await GET(reqFunis(BEARER));

    expect(res.status).toBe(401);
    expect(listPipelinesHandler).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);
    const { GET } = await import("./route");

    const res = await GET(reqFunis(BEARER));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(listPipelinesHandler).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/pipelines/[id]/stages — Bearer", () => {
  it("token agent com mcp:read → 200, filtra pela org do TOKEN no client admin", async () => {
    tokenOk();
    const { client, filtros } = adminQueRegistra();
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { GET } = await import("./[id]/stages/route");

    const res = await GET(reqEtapas(BEARER), ctxEtapas);

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(filtros).toContainEqual(["organization_id", ORG_DO_TOKEN]);
    expect(filtros).toContainEqual(["pipeline_id", PIPE]);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((e) => e.id)).toEqual(["e1"]);
  });

  it("token sem mcp:read → 403, nada é consultado", async () => {
    tokenOk(["mcp:write"]);
    const { client, filtros } = adminQueRegistra();
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { GET } = await import("./[id]/stages/route");

    const res = await GET(reqEtapas(BEARER), ctxEtapas);

    expect(res.status).toBe(403);
    expect(filtros).toEqual([]);
  });
});

/**
 * Os testes acima chamam o handler direto; este prova que o Bearer chega até
 * ele — sem entrada em PUBLIC_PATHS, o proxy devolve 401 antes.
 */
describe("leitura de funis — alcançável sem cookie (proxy)", () => {
  it("libera /api/v1/pipelines e /api/v1/pipelines/{uuid}/stages", () => {
    expect(isPublicPath("/api/v1/pipelines")).toBe(true);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE}/stages`)).toBe(true);
  });

  it("NÃO libera os irmãos, que não têm Bearer", () => {
    expect(isPublicPath("/api/v1/pipelines/default")).toBe(false);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE}`)).toBe(false);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE}/board`)).toBe(false);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE}/stages/${PIPE}`)).toBe(false);
    expect(isPublicPath("/api/v1/pipelines/nao-e-uuid/stages")).toBe(false);
  });
});
