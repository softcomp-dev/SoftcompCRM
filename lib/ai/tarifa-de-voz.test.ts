import { describe, expect, it } from "vitest";

import { TARIFAS_DE_VOZ, custoDaVozEmCentavos } from "./tarifa-de-voz";
import { AGENT_VOICE_MODEL_OPTIONS } from "./guardrails-schema";

const USO = { entradaTexto: 1_000_000, entradaAudio: 1_000_000, cacheTexto: 0, cacheAudio: 0, saidaTexto: 0, saidaAudio: 0 };

describe("tarifa da voz ao vivo", () => {
  it("1 M de tokens de áudio de entrada no gpt-realtime custa US$ 32 (3200 centavos)", () => {
    expect(custoDaVozEmCentavos("gpt-realtime", { ...USO, entradaTexto: 0 })).toBe(3200);
  });

  it("o cache sai do preço cheio e entra no preço do cache", () => {
    const cheio = custoDaVozEmCentavos("gpt-realtime-mini", { ...USO, entradaTexto: 0 })!;
    const comCache = custoDaVozEmCentavos("gpt-realtime-mini", { ...USO, entradaTexto: 0, cacheAudio: 1_000_000 })!;
    expect(cheio).toBe(1000);
    expect(comCache).toBe(30);
  });

  it("cache maior que a entrada (formato inesperado) não dá custo negativo", () => {
    expect(custoDaVozEmCentavos("gpt-realtime", { ...USO, cacheTexto: 5_000_000 })).toBeGreaterThan(0);
  });

  it("modelo sem tarifa devolve nulo", () => {
    expect(custoDaVozEmCentavos("gpt-4o-realtime-preview", USO)).toBeNull();
  });

  it("toda tarifa da tabela é de um modelo que o agente pode escolher", () => {
    for (const modelo of Object.keys(TARIFAS_DE_VOZ)) {
      expect(AGENT_VOICE_MODEL_OPTIONS as readonly string[]).toContain(modelo);
    }
  });
});
