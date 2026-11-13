/**
 * POST /api/v1/leads por token com `external_id` (ERP): 409 `lead_exists` com
 * `details.lead_id`, isolamento por organização e ramo da sessão intacto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { ApiError } from "@/lib/api/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { createLeadHandler } from "./_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("./_handler", async () => {
  const actual = await vi.importActual<typeof import("./_handler")>("./_handler");
  return { ...actual, createLeadHandler: vi.fn(async () => ({ id: "lead-novo", title: "Pedido" })) };
});
vi.mock("@/lib/leads/negocio-aberto-duplicado", async () => {
  const actual = await vi.importActual<typeof import("@/lib/leads/negocio-aberto-duplicado")>(
    "@/lib/leads/negocio-aberto-duplicado",
  );
  return { ...actual, negocioAbertoExistente: vi.fn(async () => null) };
});
vi.mock("@/lib/api/integracao-por-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/integracao-por-token")>(
    "@/lib/api/integracao-por-token",
  );
  return { ...actual, recusaDaEtapaParaToken: vi.fn(async () => null) };
});
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EXISTENTE = "11111111-1111-4111-8111-111111111111";

const corpo = { pipeline_id: FUNIL, stage_id: ETAPA, title: "Pedido 12345", source: "erp", external_id: "ped-12345" };

function req(body: unknown, headers: HeadersInit = { authorization: "Bearer dsk_abc_def" }) {
  return new NextRequest("http://localhost/api/v1/leads", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

/** `crm_leads` em memória: só a consulta (org, source, external_id). */
function bancoDeLeads(linhas: Array<Record<string, unknown>>) {
  return {
    from: () => {
      const filtros: Array<(l: Record<string, unknown>) => boolean> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        maybeSingle: async () => ({ data: linhas.find((l) => filtros.every((f) => f(l))) ?? null, error: null }),
      };
      return q;
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: "agent" as never,
    actor: { type: "api_token", id: "tok-1", role: "agent" as never },
    apiTokenId: "tok-1",
    scopes: ["mcp:write"],
  });
  vi.mocked(createAdminClient).mockReturnValue(bancoDeLeads([]));
});

describe("POST /api/v1/leads por token — external_id", () => {
  it("par novo → 201 e o external_id chega ao handler", async () => {
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(201);
    expect(vi.mocked(createLeadHandler).mock.calls[0]?.[2]).toMatchObject({
      source: "erp",
      external_id: "ped-12345",
    });
  });

  it("par já existente na organização → 409 lead_exists com details.lead_id, nada criado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      bancoDeLeads([{ id: EXISTENTE, organization_id: ORG, source: "erp", external_id: "ped-12345" }]),
    );
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: { lead_id: string } } };
    expect(body.error.code).toBe("lead_exists");
    expect(body.error.details.lead_id).toBe(EXISTENTE);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("o mesmo external_id em OUTRA organização ou em outra origem não conflita", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      bancoDeLeads([
        { id: EXISTENTE, organization_id: OUTRA, source: "erp", external_id: "ped-12345" },
        { id: "22222222-2222-4222-8222-222222222222", organization_id: ORG, source: "site", external_id: "ped-12345" },
      ]),
    );
    const { POST } = await import("./route");

    expect((await POST(req(corpo))).status).toBe(201);
  });

  it("corrida: o handler devolve o 409 do 23505 e a rota o repassa com details", async () => {
    vi.mocked(createLeadHandler).mockRejectedValueOnce(
      new ApiError(409, "lead_exists", { lead_id: EXISTENTE }, "r", "Já existe."),
    );
    const { POST } = await import("./route");

    const res = await POST(req(corpo));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: { lead_id: string } } }).error.details.lead_id).toBe(EXISTENTE);
  });

  it("external_id vazio ou acima de 200 caracteres → 422", async () => {
    const { POST } = await import("./route");
    expect((await POST(req({ ...corpo, external_id: "   " }))).status).toBe(422);
    expect((await POST(req({ ...corpo, external_id: "x".repeat(201) }))).status).toBe(422);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("sessão: external_id no corpo é ignorado (o schema da tela não mudou)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "manager" },
    } as never);
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({} as never);
    const { POST } = await import("./route");

    const res = await POST(req(corpo, {}));

    expect(res.status).toBe(201);
    expect(vi.mocked(createLeadHandler).mock.calls[0]?.[2]).not.toHaveProperty("external_id");
  });
});
