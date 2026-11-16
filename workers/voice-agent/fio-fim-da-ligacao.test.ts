/**
 * TESTE DO FIO: toda ligação SIP que termina deixa rastro (`./fim-sip.ts`).
 *
 * Antes, a ligação SIP terminava só com a linha `ended`: a recebida que
 * ninguém atendeu não virava aviso na Central e a atendida pela IA não ia
 * para a linha do tempo do negócio. Os três caminhos de fim do worker são
 * medidos aqui contra uma tabela em memória que aplica os filtros do código:
 *
 *   - o canal some tocando (`handleChannelDestroyed`) → `timeout`;
 *   - a ligação chega ao AudioSocket sem agente de voz ativo → `no_agent`,
 *     e a linha deixa de "tocar" na hora, sem esperar o canal sumir;
 *   - a IA atende e a ligação termina (`finalizeAudioSocketCall`) → `user_ended`,
 *     com o agente que atendeu e o `answered_at` gravado.
 *
 * SABOTAGEM: remover a chamada a `registrarFimDaLigacaoSip` em
 * `handleChannelDestroyed` = caso "timeout" vermelho; remover o
 * `encerrarSemAtender(…, END_REASON_SEM_AGENTE)` = caso "sem agente" vermelho.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const fakes = vi.hoisted(() => ({
  tabela: [] as Array<Record<string, unknown>>,
  fins: [] as Array<Record<string, unknown>>,
  agente: null as null | Record<string, unknown>,
  aoEncerrar: null as null | (() => Promise<void> | void),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const filtros: Array<(l: Linha) => boolean> = [];
      let mudanca: Linha | null = null;
      const alvo = () => fakes.tabela.filter((l) => filtros.every((f) => f(l)));
      const aplicar = () => {
        const linhas = alvo();
        if (mudanca) for (const l of linhas) Object.assign(l, mudanca);
        return linhas;
      };
      const consulta = {
        select: () => consulta,
        update: (m: Linha) => {
          mudanca = m;
          return consulta;
        },
        in: (col: string, valores: unknown[]) => {
          filtros.push((l) => valores.includes(l[col]));
          return consulta;
        },
        eq: (col: string, valor: unknown) => {
          filtros.push((l) => l[col] === valor);
          return consulta;
        },
        single: async () => {
          const l = aplicar()[0];
          return l ? { data: l, error: null } : { data: null, error: { message: "nada" } };
        },
        maybeSingle: async () => {
          if (tabela === "organizations") return { data: { status: "active" }, error: null };
          return { data: aplicar()[0] ?? null, error: null };
        },
        then: (ok: (r: unknown) => unknown) => Promise.resolve({ data: aplicar(), error: null }).then(ok),
      };
      return consulta;
    },
  }),
}));

vi.mock("./fim-sip", () => ({
  registrarFimDaLigacaoSip: async (p: Record<string, unknown>) => {
    fakes.fins.push(p);
  },
}));
vi.mock("@/lib/voip/ariClient", () => ({
  connectAriEvents: () => undefined,
  hangupChannel: async () => undefined,
  setChannelVariable: async () => undefined,
  continueDialplan: async () => undefined,
}));
vi.mock("@/lib/ai/agents", () => ({ getActiveVoiceAgent: async () => fakes.agente }));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({ registrarChamadaDeIa: async () => undefined }));
vi.mock("./audioSocketBridge", () => ({
  AudioSocketCallBridge: class {
    constructor(_socket: unknown, ctx: { onCallEnded: () => Promise<void> | void }) {
      fakes.aoEncerrar = ctx.onCallEnded;
    }
    usoDaSessao() {
      return { modelo: "gpt-realtime", uso: { respostas: 0 }, erro: null };
    }
  },
}));

import { handleAudioSocketConnection, handleChannelDestroyed } from "./index";

const UUID = "7aba2d23-3b56-494f-a486-952cb4a0071d";

function linhaTocando(extra: Linha = {}): Linha {
  return {
    id: "chamada-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    peer_phone: "+5527999990000",
    owner_user_id: null,
    direction: "inbound",
    status: "ringing",
    answered_at: null,
    asterisk_channel_id: UUID,
    ...extra,
  };
}

function socketFalso() {
  const s = new EventEmitter() as EventEmitter & { end: () => void };
  s.end = vi.fn();
  return s;
}

beforeEach(() => {
  fakes.tabela = [];
  fakes.fins = [];
  fakes.agente = null;
  fakes.aoEncerrar = null;
});

describe("toda ligação SIP que termina deixa rastro", () => {
  it("timeout: o canal sumiu tocando → rastro com end_reason timeout", async () => {
    fakes.tabela.push(linhaTocando());
    await handleChannelDestroyed({ type: "ChannelDestroyed", channel: { id: UUID } } as never);

    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "timeout" });
    expect(fakes.fins).toHaveLength(1);
    expect(fakes.fins[0]).toMatchObject({
      organizationId: "org-1",
      endReason: "timeout",
      ligacao: { id: "chamada-1", direction: "inbound", contact_id: "contato-1" },
    });
  });

  it("sem agente de voz: a linha encerra na hora com no_agent, e deixa rastro", async () => {
    fakes.tabela.push(linhaTocando());
    const socket = socketFalso();
    await handleAudioSocketConnection(socket as never, UUID, Buffer.alloc(0));

    expect(socket.end).toHaveBeenCalled();
    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "no_agent" });
    expect(fakes.fins).toEqual([
      expect.objectContaining({ endReason: "no_agent", organizationId: "org-1" }),
    ]);
  });

  it("atendida pela IA: o fim leva user_ended, o agente e o answered_at", async () => {
    fakes.agente = { id: "agente-1", systemPrompt: "", voice: "alloy", apiKey: "k" };
    fakes.tabela.push(linhaTocando());
    await handleAudioSocketConnection(socketFalso() as never, UUID, Buffer.alloc(0));
    expect(fakes.aoEncerrar).not.toBeNull();

    await fakes.aoEncerrar!();

    expect(fakes.fins).toHaveLength(1);
    expect(fakes.fins[0]).toMatchObject({ endReason: "user_ended", agentId: "agente-1" });
    expect(typeof (fakes.fins[0]!.ligacao as Linha).answered_at).toBe("string");
  });

  it("a ligação que o canal derruba DEPOIS de atendida não ganha um segundo rastro", async () => {
    fakes.tabela.push(linhaTocando({ status: "connected" }));
    await handleChannelDestroyed({ type: "ChannelDestroyed", channel: { id: UUID } } as never);
    expect(fakes.fins).toHaveLength(0);
  });
});
