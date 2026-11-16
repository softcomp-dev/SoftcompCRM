import { describe, expect, it } from "vitest";

import { classificar, LIMITES_PADRAO } from "./classificacao";
import { janelaDoAviso, JANELA_DO_AVISO_DIAS, precisaAvisar } from "./aviso-de-pre-inativo";

const AGORA = new Date("2026-11-16T12:00:00.000Z");
const DIA = 86_400_000;
const haDias = (n: number) => new Date(AGORA.getTime() - n * DIA).toISOString();

describe("janelaDoAviso", () => {
  it("pega quem cruzou o prazo de ativo nos últimos dias da janela", () => {
    const { de, ate } = janelaDoAviso(LIMITES_PADRAO, AGORA);
    expect(ate).toBe(haDias(90));
    expect(de).toBe(haDias(90 + JANELA_DO_AVISO_DIAS));
    // Quem está dentro é, de fato, pré-inativo pela régua do selo.
    expect(classificar(haDias(91), LIMITES_PADRAO, AGORA)).toBe("pre_inativo");
  });

  it("não recua além do prazo de pré-inativo (inativo não recebe aviso de pré)", () => {
    const { de } = janelaDoAviso({ ativoDias: 30, preInativoDias: 33 }, AGORA);
    expect(de).toBe(haDias(33));
  });
});

describe("precisaAvisar", () => {
  const venda = "2026-08-01T10:00:00.000Z";
  it("avisa quem nunca foi avisado", () => {
    expect(precisaAvisar({ last_won_at: venda, pre_inativo_avisado_para: null })).toBe(true);
  });
  it("não repete o aviso da mesma venda, mesmo com formatos diferentes", () => {
    expect(precisaAvisar({ last_won_at: venda, pre_inativo_avisado_para: "2026-08-01T10:00:00+00:00" })).toBe(false);
  });
  it("avisa de novo depois de uma compra nova", () => {
    expect(precisaAvisar({ last_won_at: venda, pre_inativo_avisado_para: "2026-03-01T10:00:00.000Z" })).toBe(true);
  });
  it("sem venda, não avisa", () => {
    expect(precisaAvisar({ last_won_at: null, pre_inativo_avisado_para: null })).toBe(false);
  });
});
