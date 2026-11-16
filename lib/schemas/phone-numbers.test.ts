import { describe, expect, it } from "vitest";

import { createPhoneNumberSchema, faltaDestinoHumano, updatePhoneNumberSchema } from "./phone-numbers";

describe("telefone do time no número de voz", () => {
  it("modo humano sem destino não tem como se cumprir", () => {
    expect(faltaDestinoHumano("human", null)).toBe(true);
    expect(faltaDestinoHumano("ai_then_human", "  ")).toBe(true);
    expect(faltaDestinoHumano("human", "+5527999990000")).toBe(false);
    expect(faltaDestinoHumano("ai", null)).toBe(false);
  });

  it("o cadastro recusa modo humano sem telefone do time, apontando o campo", () => {
    const r = createPhoneNumberSchema.safeParse({ number: "552731912377", routing_mode: "human" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["forward_to_phone"]);
  });

  it("o cadastro aceita modo humano com telefone e toque dentro da faixa", () => {
    const r = createPhoneNumberSchema.safeParse({
      number: "552731912377",
      routing_mode: "human",
      forward_to_phone: "+5527999990000",
      forward_ring_seconds: 30,
    });
    expect(r.success).toBe(true);
  });

  it("telefone com letra ou toque fora de 10–60 s é recusado", () => {
    expect(updatePhoneNumberSchema.safeParse({ forward_to_phone: "27 9999-0000" }).success).toBe(false);
    expect(updatePhoneNumberSchema.safeParse({ forward_ring_seconds: 5 }).success).toBe(false);
    expect(updatePhoneNumberSchema.safeParse({ forward_ring_seconds: 90 }).success).toBe(false);
  });
});
