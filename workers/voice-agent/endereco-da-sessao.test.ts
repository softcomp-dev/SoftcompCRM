import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ws", () => ({ default: class {} }));

import { enderecoDaSessaoDeVoz } from "./audioSocketBridge";

afterEach(() => {
  delete process.env.OPENAI_REALTIME_URL;
});

describe("endereço da sessão de voz", () => {
  it("sem a variável (ou vazia), a OpenAI", () => {
    expect(enderecoDaSessaoDeVoz()).toBe("wss://api.openai.com/v1/realtime");
    process.env.OPENAI_REALTIME_URL = "  ";
    expect(enderecoDaSessaoDeVoz()).toBe("wss://api.openai.com/v1/realtime");
  });

  it("com a variável, o endereço dela (o teste de ligação do CI)", () => {
    process.env.OPENAI_REALTIME_URL = "ws://127.0.0.1:8099";
    expect(enderecoDaSessaoDeVoz()).toBe("ws://127.0.0.1:8099");
  });
});
