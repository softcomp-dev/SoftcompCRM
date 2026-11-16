/**
 * TESTE DO FIO: o agente de voz escolhido no NÚMERO atende a ligação.
 *
 * A tela de Telefonia deixa escolher o agente de cada número
 * (`phone_numbers.default_ai_agent_id`), e o worker ignorava a escolha: toda
 * ligação caía no primeiro agente de voz ativo que o banco devolvesse. O fio
 * tem dois elos, e os dois são medidos:
 *
 *   1. a entrada (`handleStasisStart`) grava o agente do número em
 *      `voice_calls.ai_agent_id`;
 *   2. o atendimento (`handleAudioSocketConnection`) pede esse agente a
 *      `getActiveVoiceAgent` — que só o usa se ainda for um agente de voz
 *      ativo da organização (`lib/ai/agents.ts`).
 *
 * SABOTAGEM: tirar o `ai_agent_id: routing.default_ai_agent_id` do insert ou o
 * segundo argumento de `getActiveVoiceAgent` = caso correspondente vermelho.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  inseridas: [] as Array<Record<string, unknown>>,
  pedidos: [] as Array<unknown[]>,
  linha: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const consulta = {
        insert: (l: Record<string, unknown>) => {
          fakes.inseridas.push(l);
          const r = { data: { id: "chamada-1", ...l }, error: null };
          return { select: () => ({ single: async () => r }) };
        },
        select: () => consulta,
        update: () => consulta,
        eq: () => consulta,
        in: () => consulta,
        single: async () => ({ data: fakes.linha, error: null }),
        maybeSingle: async () =>
          tabela === "organizations" ? { data: { status: "active" }, error: null } : { data: null, error: null },
        then: (ok: (r: unknown) => unknown) => Promise.resolve({ data: [{ id: "chamada-1" }], error: null }).then(ok),
      };
      return consulta;
    },
    rpc: () => ({
      single: async () => ({
        data: { organization_id: "org-1", routing_mode: "ai", default_ai_agent_id: "agente-do-numero", fallback_user_id: null },
        error: null,
      }),
    }),
  }),
}));

vi.mock("@/lib/ai/agents", () => ({
  getActiveVoiceAgent: async (...args: unknown[]) => {
    fakes.pedidos.push(args);
    return null;
  },
}));
vi.mock("./fim-sip", () => ({ registrarFimDaLigacaoSip: async () => undefined }));
vi.mock("@/lib/voip/ariClient", () => ({
  connectAriEvents: () => undefined,
  hangupChannel: async () => undefined,
  setChannelVariable: async () => undefined,
  continueDialplan: async () => undefined,
}));
vi.mock("@/lib/voip/resolve-caller", () => ({
  resolveOrCreateCallerContact: async () => ({ id: "contato-1", is_blocked: false, is_personal: false }),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: async () => ({ criado: false, motivo: "ja_existe" }),
}));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));

import { handleAudioSocketConnection, handleStasisStart } from "./index";

beforeEach(() => {
  fakes.inseridas = [];
  fakes.pedidos = [];
  fakes.linha = null;
});

describe("o agente do número atende", () => {
  it("a entrada grava o agente que o número aponta", async () => {
    await handleStasisStart({
      type: "StasisStart",
      channel: { id: "1789081888.7", dialplan: { exten: "552731912377" }, caller: { number: "27999990000" } },
    } as never);
    expect(fakes.inseridas[0]).toMatchObject({ status: "ringing", ai_agent_id: "agente-do-numero" });
  });

  it("o atendimento pede o agente gravado na linha", async () => {
    fakes.linha = {
      id: "chamada-1",
      organization_id: "org-1",
      status: "ringing",
      direction: "inbound",
      ai_agent_id: "agente-do-numero",
    };
    const socket = new EventEmitter() as EventEmitter & { end: () => void };
    socket.end = vi.fn();
    await handleAudioSocketConnection(socket as never, "uuid-1", Buffer.alloc(0));
    expect(fakes.pedidos).toEqual([["org-1", "agente-do-numero"]]);
  });
});
