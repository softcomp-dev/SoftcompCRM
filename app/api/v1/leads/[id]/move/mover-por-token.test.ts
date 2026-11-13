/**
 * POST /api/v1/leads/[id]/move por Bearer `dsk_…` — mudar etapa a partir de um ERP.
 *
 * O ramo da sessão (o board) confia na RLS e por isso não serve ao token; o
 * ramo do token vai pelo `moveLeadHandler`, o mesmo da tool MCP
 * `crm_move_lead_stage`. O que esta suíte prova:
 *
 * - token com `mcp:write` move (200) pelo handler, com a org do TOKEN e o
 *   client admin — e o client de sessão nem é criado;
 * - o corpo é o curto (`stage_id` + motivos); `custom_fields` e
 *   `expected_updated_at` são RECUSADOS (422), não descartados em silêncio;
 * - sem o escopo, 403; token inválido, 401; acima do teto, 429;
 * - a recusa de negócio do handler (campos exigidos, por exemplo) chega com
 *   código, status e `details`;
 * - o path passa pelo proxy sem cookie, e os irmãos (`clone`, `win`…) não.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { moveLeadHandler } from "../../_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../../_handler", () => ({
  moveLeadHandler: vi.fn(async () => ({ id: "lead-1", stage_id: "etapa-nova" })),
}));
vi.mock("@/lib/api/integracao-por-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/integracao-por-token")>(
    "@/lib/api/integracao-por-token",
  );
  // A régua da etapa tem suíte própria (lib/api/integracao-por-token.test.ts);
  // aqui ela entra como espião, aprovando por padrão.
  return { ...actual, recusaDaEtapaParaToken: vi.fn(async () => null) };
});
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_DO_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADMIN = { admin: true } as never;
const ctx = { params: Promise.resolve({ id: LEAD }) };

function req(body: unknown, headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD}/move`, {
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

describe("POST /api/v1/leads/[id]/move — Bearer", () => {
  it("token com mcp:write → 200 pelo moveLeadHandler, org do TOKEN, client admin", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ stage_id: ETAPA, reason: "Pedido faturado no ERP" }), ctx);

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    const [client, hctx, leadId, input] = vi.mocked(moveLeadHandler).mock.calls[0] ?? [];
    expect(client).toBe(ADMIN);
    expect(hctx).toMatchObject({
      organization_id: ORG_DO_TOKEN,
      actor: { type: "api_token", id: "tok-1" },
    });
    expect(leadId).toBe(LEAD);
    expect(input).toMatchObject({ to_stage_id: ETAPA, reason: "Pedido faturado no ERP" });
  });

  it("motivo da perda e do ganho viajam até o handler", async () => {
    tokenOk();
    const { POST } = await import("./route");

    await POST(req({ stage_id: ETAPA, lost_reason: "preco", won_reason: "x" }), ctx);

    expect(vi.mocked(moveLeadHandler).mock.calls[0]?.[3]).toMatchObject({
      lost_reason: "preco",
      won_reason: "x",
    });
  });

  it.each([
    ["custom_fields", { custom_fields: { pedido: "1" } }],
    ["expected_updated_at", { expected_updated_at: "2026-11-09T18:00:00Z" }],
  ])("campo %s é recusado (422), não descartado em silêncio", async (_nome, extra) => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ stage_id: ETAPA, ...extra }), ctx);

    expect(res.status).toBe(422);
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("sem stage_id → 422", async () => {
    tokenOk();
    const { POST } = await import("./route");

    const res = await POST(req({ reason: "x" }), ctx);

    expect(res.status).toBe(422);
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("token sem mcp:write → 403, nada se move", async () => {
    tokenOk(["mcp:read"]);
    const { POST } = await import("./route");

    const res = await POST(req({ stage_id: ETAPA }), ctx);

    expect(res.status).toBe(403);
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("token inválido → 401, nada se move", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const { POST } = await import("./route");

    const res = await POST(req({ stage_id: ETAPA }), ctx);

    expect(res.status).toBe(401);
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);
    const { POST } = await import("./route");

    const res = await POST(req({ stage_id: ETAPA }), ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("recusa de negócio do handler chega com código, status e details", async () => {
    tokenOk();
    vi.mocked(moveLeadHandler).mockRejectedValueOnce(
      new ApiError(422, "required_fields_missing", { faltando: [{ chave: "pedido" }] }, "r", "Faltam campos."),
    );
    const { POST } = await import("./route");

    const res = await POST(req({ stage_id: ETAPA }), ctx);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("required_fields_missing");
    expect(body.error.details).toEqual({ faltando: [{ chave: "pedido" }] });
  });
});

describe("POST /api/v1/leads/[id]/move — alcançável sem cookie (proxy)", () => {
  it("libera /api/v1/leads/{uuid}/move", () => {
    expect(isPublicPath(`/api/v1/leads/${LEAD}/move`)).toBe(true);
  });

  it("NÃO libera os irmãos, que não têm Bearer", () => {
    expect(isPublicPath(`/api/v1/leads/${LEAD}/clone`)).toBe(false);
    // `/win` e `/lose` passaram a aceitar token (o ERP fecha o negócio numa
    // chamada) e abrem no proxy — ver tests/unit/rotas-do-erp-no-proxy.test.ts.
    expect(isPublicPath(`/api/v1/leads/${LEAD}/retomar`)).toBe(false);
    expect(isPublicPath("/api/v1/leads/nao-e-uuid/move")).toBe(false);
  });
});
