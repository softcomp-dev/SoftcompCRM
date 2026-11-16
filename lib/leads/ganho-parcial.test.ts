import { describe, expect, it } from "vitest";

import {
  GanhoParcialSchema,
  patchDoGanhoParcial,
  recusaDoValorParcial,
  valorPrevistoCents,
} from "./ganho-parcial";

describe("ganho parcial — a regra", () => {
  it("valor fechado menor que o previsto passa", () => {
    expect(recusaDoValorParcial({ value_cents: 100_000 }, 60_000)).toBeNull();
  });

  it("valor igual ao previsto é ganho total, não parcial", () => {
    expect(recusaDoValorParcial({ value_cents: 100_000 }, 100_000)).toBe("nao_e_menor_que_o_previsto");
  });

  it("valor zero ou negativo é recusado", () => {
    expect(recusaDoValorParcial({ value_cents: 100_000 }, 0)).toBe("sem_valor");
    expect(recusaDoValorParcial({ value_cents: 100_000 }, -5)).toBe("sem_valor");
  });

  it("sem valor previsto, qualquer valor positivo vale", () => {
    expect(recusaDoValorParcial({ value_cents: null }, 1)).toBeNull();
  });

  it("num negócio que já é parcial, o previsto é o guardado — não o fechado", () => {
    const lead = { value_cents: 60_000, is_partial_win: true, partial_original_value_cents: 100_000 };
    expect(valorPrevistoCents(lead)).toBe(100_000);
    // Corrigir de 600 para 800 continua parcial: o teto é o previsto, 1.000.
    expect(recusaDoValorParcial(lead, 80_000)).toBeNull();
    expect(patchDoGanhoParcial(lead, { value_cents: 80_000, reason: "x" })).toMatchObject({
      partial_original_value_cents: 100_000,
      value_cents: 80_000,
    });
  });

  it("o patch guarda o previsto e grava o fechado e o motivo aparado", () => {
    expect(patchDoGanhoParcial({ value_cents: "100000" }, { value_cents: 60_000, reason: "  metade do lote " })).toEqual({
      is_partial_win: true,
      partial_reason: "metade do lote",
      partial_original_value_cents: 100_000,
      value_cents: 60_000,
    });
  });

  it("o schema exige valor inteiro positivo e motivo não vazio", () => {
    expect(GanhoParcialSchema.safeParse({ value_cents: 10, reason: "ok" }).success).toBe(true);
    expect(GanhoParcialSchema.safeParse({ value_cents: 10, reason: "   " }).success).toBe(false);
    expect(GanhoParcialSchema.safeParse({ value_cents: 10.5, reason: "ok" }).success).toBe(false);
    expect(GanhoParcialSchema.safeParse({ reason: "ok" }).success).toBe(false);
  });
});
