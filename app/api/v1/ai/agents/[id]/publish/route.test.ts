/**
 * POST /api/v1/ai/agents/:id/publish — a recusa diz o MOTIVO.
 *
 * Antes, os 14 códigos de `PublishErrorCode` saíam com o mesmo texto
 * ("Validação de publish falhou."): o código estava certo, mas quem integra
 * lia a mensagem e não sabia o que corrigir (ex.: versão criada com
 * `channel_session_id: null` fora de roteador).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_ERROR_CODES, type PublishErrorCode } from "@/lib/ai/agents/validation";
import { publishAgentVersion } from "@/lib/ai/agents/publish";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    organizationId: ORG,
    actor: { type: "api_token", id: "tok" },
    supabase: {},
    via: "token",
    idioma: "pt-BR",
  })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    const versao = { id: VERSION, agent_id: AGENT, organization_id: ORG, tool_ids: [], status: "draft" };
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: versao, error: null }),
    };
    return { from: () => q };
  }),
}));
vi.mock("@/lib/ai/agents/publish", () => ({ publishAgentVersion: vi.fn() }));

function publicar() {
  return new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}/publish`, {
    method: "POST",
    body: JSON.stringify({ version_id: VERSION }),
    headers: { "content-type": "application/json", authorization: "Bearer dsk_a_b" },
  });
}

describe("POST /ai/agents/:id/publish — mensagem por motivo", () => {
  beforeEach(() => vi.mocked(publishAgentVersion).mockReset());

  it("versão sem canal: 422 channel_session_not_found dizendo o que informar", async () => {
    vi.mocked(publishAgentVersion).mockResolvedValue({
      ok: false,
      code: "channel_session_not_found",
      message: "channel_session_not_found",
    } as never);
    const { POST } = await import("./route");

    const res = await POST(publicar(), { params: Promise.resolve({ id: AGENT }) });

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("channel_session_not_found");
    expect(corpo.error.message).toContain("channel_session_id");
  });

  it("todo código de recusa sai com texto próprio, nenhum igual ao de outro", async () => {
    const { POST } = await import("./route");
    const textos: string[] = [];
    for (const code of PUBLISH_ERROR_CODES as ReadonlySet<PublishErrorCode>) {
      vi.mocked(publishAgentVersion).mockResolvedValue({ ok: false, code, message: code } as never);
      const res = await POST(publicar(), { params: Promise.resolve({ id: AGENT }) });
      const corpo = await res.json();
      expect(corpo.error.code).toBe(code);
      textos.push(corpo.error.message);
    }
    expect(textos.every((t) => t.length > 10 && t !== "Validação de publish falhou.")).toBe(true);
    expect(new Set(textos).size).toBe(textos.length);
  });
});
