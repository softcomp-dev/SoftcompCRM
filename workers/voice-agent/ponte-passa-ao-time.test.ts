/**
 * A PONTE DE VOZ passa a ligação ao time (modo "IA, depois time humano").
 *
 * A ferramenta `passar_para_o_time` só existe quando há para onde passar
 * (`onPassarAoTime` presente): sem ela, a IA não pode prometer transferência.
 * Quando o modelo a chama, a ponte drena o "vou transferir", marca o canal
 * (`onPassarAoTime`) ANTES de fechar o socket — fechado o AudioSocket, o
 * dialplan segue na hora — e só então avisa o fim da sessão.
 *
 * SABOTAGEM: remover o bloco `pediuOTime` de `response.done` = o caso
 * "a IA chama a ferramenta" fica vermelho.
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  ultimoWs: null as (EventEmitter & { send: ReturnType<typeof vi.fn>; readyState: number }) | null,
}));

vi.mock("ws", async () => {
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      fakes.ultimoWs = this as never;
    }
  }
  return { default: FakeWs };
});

import { AudioSocketCallBridge } from "./audioSocketBridge";

function socketDeBrinquedo() {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.setNoDelay = vi.fn();
  s.write = vi.fn();
  s.end = vi.fn();
  s.destroyed = false;
  return s;
}

function sessaoEnviada() {
  return JSON.parse(fakes.ultimoWs!.send.mock.calls[0]![0] as string) as {
    session: { instructions: string; tools: Array<{ name: string }> };
  };
}

async function abrirSessao() {
  fakes.ultimoWs!.emit("open");
  await vi.waitFor(() => expect(fakes.ultimoWs!.send).toHaveBeenCalled());
}

let ponte: AudioSocketCallBridge | null = null;
afterEach(() => {
  ponte?.close();
  ponte = null;
});
beforeEach(() => {
  fakes.ultimoWs = null;
});

function abrirPonte(opcoes: { onPassarAoTime?: () => Promise<void>; onCallEnded?: () => void } = {}) {
  const socket = socketDeBrinquedo();
  ponte = new AudioSocketCallBridge(socket as never, {
    callId: "call1",
    organizationId: "org1",
    agentInstructions: "Você é a Ana.",
    voice: "marin",
    voiceSpeed: 1,
    voiceModel: "gpt-realtime",
    onTranscriptTurn: () => {},
    onCallEnded: opcoes.onCallEnded ?? (() => {}),
    knowledgeSourceIdsPromise: Promise.resolve([]),
    searchKnowledge: async () => ({ trechos: [] }),
    ...(opcoes.onPassarAoTime ? { onPassarAoTime: opcoes.onPassarAoTime } : {}),
  });
  return socket;
}

describe("ponte de voz: passar ao time", () => {
  it("sem para onde passar, a ferramenta nem é oferecida", async () => {
    abrirPonte();
    await abrirSessao();
    const sessao = sessaoEnviada();
    expect(sessao.session.tools.map((t) => t.name)).not.toContain("passar_para_o_time");
    expect(sessao.session.instructions).not.toContain("passar_para_o_time");
  });

  it("com telefone do time, a ferramenta e a instrução entram na sessão", async () => {
    abrirPonte({ onPassarAoTime: async () => {} });
    await abrirSessao();
    const sessao = sessaoEnviada();
    expect(sessao.session.tools.map((t) => t.name)).toContain("passar_para_o_time");
    expect(sessao.session.instructions).toContain("passar_para_o_time");
  });

  it("a IA chama a ferramenta: marca o canal ANTES de fechar, e só então encerra a sessão", async () => {
    const ordem: string[] = [];
    const socket = abrirPonte({
      onPassarAoTime: async () => {
        ordem.push("marcar");
      },
      onCallEnded: () => ordem.push("fim"),
    });
    (socket.end as ReturnType<typeof vi.fn>).mockImplementation(() => ordem.push("fechar"));
    await abrirSessao();

    fakes.ultimoWs!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.done",
          response: { output: [{ type: "function_call", name: "passar_para_o_time" }] },
        }),
      ),
    );

    await vi.waitFor(() => expect(ordem).toContain("fechar"), { timeout: 2000 });
    expect(ordem).toEqual(["marcar", "fim", "fechar"]);
    expect(ponte!.pediuOTime()).toBe(true);
  });

  it("sem onPassarAoTime, um pedido de passar é ignorado (não há como cumprir)", async () => {
    abrirPonte();
    await abrirSessao();
    fakes.ultimoWs!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.done",
          response: { output: [{ type: "function_call", name: "passar_para_o_time" }] },
        }),
      ),
    );
    expect(ponte!.pediuOTime()).toBe(false);
  });
});
