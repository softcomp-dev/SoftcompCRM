import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { fraseDeQuemNaoPode, haQuantoTempo } from "./LeadsSemVendedor";

describe("haQuantoTempo", () => {
  const agora = new Date("2026-11-13T12:00:00.000Z");

  it("menos de uma hora, horas até dois dias, depois dias", () => {
    expect(haQuantoTempo("2026-11-13T11:30:00.000Z", agora)).toBe("<1h");
    expect(haQuantoTempo("2026-11-13T09:00:00.000Z", agora)).toBe("3h");
    expect(haQuantoTempo("2026-11-11T13:00:00.000Z", agora)).toBe("47h");
    expect(haQuantoTempo("2026-11-11T12:00:00.000Z", agora)).toBe("2d");
    expect(haQuantoTempo("2026-10-14T12:00:00.000Z", agora)).toBe("30d");
  });

  it("relógio adiantado no servidor não vira tempo negativo", () => {
    expect(haQuantoTempo("2026-11-13T12:05:00.000Z", agora)).toBe("<1h");
  });
});

describe("fraseDeQuemNaoPode", () => {
  it("função desligada e 'não é SDR' são frases diferentes, e as duas têm tradução", () => {
    const desligada = fraseDeQuemNaoPode("feature_disabled");
    const naoESdr = fraseDeQuemNaoPode("not_assigned");
    expect(desligada).not.toBe(naoESdr);
    expect(naoESdr).toBe(fraseDeQuemNaoPode(null));
    // `t(variável)`: a cerca de i18n só enxerga literal, então a prova é aqui.
    for (const frase of [desligada, naoESdr]) expect(DICIONARIO[frase]?.es).toBeTruthy();
  });
});
