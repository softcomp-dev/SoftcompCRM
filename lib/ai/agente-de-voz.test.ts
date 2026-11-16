/**
 * `getActiveVoiceAgent` com o agente escolhido no número (`lib/ai/agents.ts`).
 *
 * O escolhido vence quando ainda é agente de voz ativo da organização; senão
 * vale o primeiro agente de voz ativo — a escolha nunca deixa a ligação sem
 * atendimento só porque o agente foi desativado depois.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  agentes: [] as Array<{ id: string; system_prompt: string; config: unknown; organization_id: string }>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const consulta = {
        select: () => consulta,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return consulta;
        },
        not: () => consulta,
        order: () => consulta,
        limit: () => consulta,
        maybeSingle: async () => {
          if (tabela !== "ai_agents") return { data: null, error: null };
          const achado = fakes.agentes.find((a) =>
            filtros.every(([c, v]) => (c in a ? (a as Record<string, unknown>)[c] === v : true)),
          );
          return { data: achado ?? null, error: null };
        },
      };
      return consulta;
    },
  }),
}));

import { getActiveVoiceAgent } from "./agents";

beforeEach(() => {
  fakes.agentes = [
    { id: "primeiro", system_prompt: "p1", config: {}, organization_id: "org-1" },
    { id: "escolhido", system_prompt: "p2", config: {}, organization_id: "org-1" },
  ];
});

describe("getActiveVoiceAgent", () => {
  it("usa o agente escolhido no número", async () => {
    expect((await getActiveVoiceAgent("org-1", "escolhido"))?.id).toBe("escolhido");
  });

  it("escolhido que não existe mais (ou é de outra organização) cai no primeiro ativo", async () => {
    expect((await getActiveVoiceAgent("org-1", "sumiu"))?.id).toBe("primeiro");
    fakes.agentes[1]!.organization_id = "org-2";
    expect((await getActiveVoiceAgent("org-1", "escolhido"))?.id).toBe("primeiro");
  });

  it("sem escolha, o primeiro ativo, como antes", async () => {
    expect((await getActiveVoiceAgent("org-1"))?.id).toBe("primeiro");
  });
});
