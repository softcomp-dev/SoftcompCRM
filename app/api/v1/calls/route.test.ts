/**
 * POST /api/v1/calls — `mode: "human"` não finge.
 *
 * O modo existia no contrato, a rota gravava `handled_by: 'human'` e o worker
 * de voz abria a IA do mesmo jeito: quem pedia "eu falo" recebia uma ligação
 * atendida por robô, sem aviso. Enquanto o atendente não tem de onde falar, a
 * rota recusa com 422 `voice_human_mode_unavailable` — antes de gravar linha
 * e antes de originar qualquer canal.
 */
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/voip/ariClient", () => ({ originateCall: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { originateCall } from "@/lib/voip/ariClient";

import { POST } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";

function pedido(corpo: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/calls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER },
    org: { orgId: ORG, role: "manager" },
  } as never);
  vi.mocked(createClient).mockReset();
  vi.mocked(originateCall).mockReset();
});

describe("POST /api/v1/calls — mode human", () => {
  it("recusa com 422 voice_human_mode_unavailable, sem gravar nem originar", async () => {
    const res = await POST(pedido({ toNumber: "5527999990000", mode: "human" }));
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("voice_human_mode_unavailable");
    expect(createClient).not.toHaveBeenCalled();
    expect(originateCall).not.toHaveBeenCalled();
  });
});
