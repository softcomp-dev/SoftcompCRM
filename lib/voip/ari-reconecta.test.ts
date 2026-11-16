/**
 * A conexão de eventos com o Asterisk (ARI) se refaz quando cai.
 *
 * Sem isto, um reinício do Asterisk (a atualização o recria) deixava o worker
 * vivo, com healthcheck verde, e a Stasis app inexistente: toda ligação recebida
 * caía até alguém reiniciar o worker à mão.
 *
 * SABOTAGEM: remover o `setTimeout(conectar, espera)` do `close` = o caso
 * "reconecta" fica vermelho.
 */
import type { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ conexoes: [] as Array<EventEmitter & { close: () => void }> }));

vi.mock("ws", async () => {
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    close = vi.fn();
    constructor() {
      super();
      fakes.conexoes.push(this as never);
    }
  }
  return { default: FakeWs };
});

import { connectAriEvents, esperaDaReconexao } from "./ariClient";

beforeEach(() => {
  fakes.conexoes = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("eventos do ARI", () => {
  it("reconecta quando a conexão cai, com espera crescente", () => {
    const c = connectAriEvents(() => {});
    expect(fakes.conexoes).toHaveLength(1);

    fakes.conexoes[0]!.emit("close");
    vi.advanceTimersByTime(999);
    expect(fakes.conexoes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fakes.conexoes).toHaveLength(2);

    fakes.conexoes[1]!.emit("close");
    vi.advanceTimersByTime(2_000);
    expect(fakes.conexoes).toHaveLength(3);
    c.parar();
  });

  it("depois de conectar, a espera volta ao começo", () => {
    const c = connectAriEvents(() => {});
    fakes.conexoes[0]!.emit("close");
    vi.advanceTimersByTime(1_000);
    fakes.conexoes[1]!.emit("open");
    fakes.conexoes[1]!.emit("close");
    vi.advanceTimersByTime(1_000);
    expect(fakes.conexoes).toHaveLength(3);
    c.parar();
  });

  it("parado, não reconecta", () => {
    const c = connectAriEvents(() => {});
    c.parar();
    fakes.conexoes[0]!.emit("close");
    vi.advanceTimersByTime(60_000);
    expect(fakes.conexoes).toHaveLength(1);
  });

  it("a espera tem teto de 30 s", () => {
    expect(esperaDaReconexao(0)).toBe(1_000);
    expect(esperaDaReconexao(4)).toBe(16_000);
    expect(esperaDaReconexao(20)).toBe(30_000);
  });
});
