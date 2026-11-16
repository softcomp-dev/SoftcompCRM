import { describe, expect, it } from "vitest";

import {
  payloadDaInteracao,
  registrarInteracaoSchema,
  tipoDaInteracao,
} from "./interacao-manual";

const valido = {
  lead_id: "6f0b8f2e-6c7a-4a8e-9a77-0d0b9f4c1a11",
  channel: "phone",
  direction: "outbound",
  outcome: "talked",
  summary: "Combinamos a visita técnica para sexta",
};

describe("registrarInteracaoSchema", () => {
  it("aceita o registro mínimo e apara o texto", () => {
    const r = registrarInteracaoSchema.parse({ ...valido, summary: "  ok  " });
    expect(r.summary).toBe("ok");
  });

  it("recusa resumo vazio, canal fora do vocabulário, campo a mais e data no futuro", () => {
    expect(registrarInteracaoSchema.safeParse({ ...valido, summary: "   " }).success).toBe(false);
    expect(registrarInteracaoSchema.safeParse({ ...valido, channel: "telegram" }).success).toBe(false);
    expect(registrarInteracaoSchema.safeParse({ ...valido, organization_id: valido.lead_id }).success).toBe(false);
    const amanha = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    expect(registrarInteracaoSchema.safeParse({ ...valido, occurred_at: amanha }).success).toBe(false);
  });

  it("recusa duração negativa ou acima de um dia", () => {
    expect(registrarInteracaoSchema.safeParse({ ...valido, duration_minutes: -1 }).success).toBe(false);
    expect(registrarInteracaoSchema.safeParse({ ...valido, duration_minutes: 1441 }).success).toBe(false);
    expect(registrarInteracaoSchema.safeParse({ ...valido, duration_minutes: 15 }).success).toBe(true);
  });
});

describe("tipoDaInteracao", () => {
  it("falar com o cliente e tentar sem resposta são tipos diferentes (o gatilho do silêncio só lê o tipo)", () => {
    expect(tipoDaInteracao("talked")).toBe("interaction_logged");
    expect(tipoDaInteracao("no_answer")).toBe("interaction_attempted");
  });
});

describe("payloadDaInteracao", () => {
  it("leva só a forma do contato, nunca o texto (o texto vai em reason, que a LGPD apaga)", () => {
    const p = payloadDaInteracao(registrarInteracaoSchema.parse({ ...valido, duration_minutes: 10 }));
    expect(p).toEqual({ channel: "phone", direction: "outbound", outcome: "talked", duration_minutes: 10 });
    expect(JSON.stringify(p)).not.toContain(valido.summary);
  });
});
