import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/consolidado/servidor", () => ({ abrirVisaoConsolidada: vi.fn() }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler: vi.fn() }));

import { POST } from "./route";

const ATIVA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ALHEIA = "99999999-9999-4999-8999-999999999999";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ETAPA = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

function portaCom(orgDoLead: string | null) {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: orgDoLead ? { id: LEAD, organization_id: orgDoLead } : null,
            error: null,
          }),
        }),
      }),
    }),
  };
  vi.mocked(abrirVisaoConsolidada).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" } as never,
    supabase: supabase as never,
    vinculos: [
      { organization_id: ATIVA, nome: "Ativa", role: "admin" },
      { organization_id: OUTRA, nome: "Outra", role: "agent" },
    ],
    escopo: [],
    t: (s: string) => s,
  });
}

function pedido(corpo: unknown) {
  return new NextRequest("http://x/api/v1/consolidado/funil/mover", {
    method: "POST",
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true } as never);
  vi.mocked(moveLeadHandler).mockResolvedValue({ id: LEAD } as never);
});

describe("POST /api/v1/consolidado/funil/mover", () => {
  it("move card de OUTRA empresa da pessoa, conferindo o papel NELA", async () => {
    portaCom(OUTRA);
    const res = await POST(pedido({ lead_id: LEAD, stage_id: ETAPA }));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ organizationId: OUTRA }),
    );
    expect(moveLeadHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organization_id: OUTRA, actor: { type: "user", id: USER } }),
      LEAD,
      expect.objectContaining({ to_stage_id: ETAPA }),
    );
  });

  it("card de empresa que não é da pessoa dá 404 sem chegar à escrita", async () => {
    portaCom(ALHEIA);
    const res = await POST(pedido({ lead_id: LEAD, stage_id: ETAPA }));
    expect(res.status).toBe(404);
    expect(requireRole).not.toHaveBeenCalled();
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("papel insuficiente na empresa do card barra a escrita", async () => {
    portaCom(OUTRA);
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await POST(pedido({ lead_id: LEAD, stage_id: ETAPA }));
    expect(res.status).toBe(403);
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("recusa campo desconhecido no corpo", async () => {
    portaCom(OUTRA);
    const res = await POST(pedido({ lead_id: LEAD, stage_id: ETAPA, organization_id: OUTRA }));
    expect(res.status).toBe(422);
  });
});
