import { describe, expect, it } from "vitest";

import {
  classificar,
  cortesDaClassificacao,
  LIMITES_PADRAO,
  limitesDaOrganizacao,
} from "./classificacao";

const AGORA = new Date("2026-11-16T12:00:00.000Z");
const DIA = 86_400_000;
const haDias = (n: number) => new Date(AGORA.getTime() - n * DIA).toISOString();

describe("classificar", () => {
  it("sem venda ganha é sem_compra", () => {
    expect(classificar(null, LIMITES_PADRAO, AGORA)).toBe("sem_compra");
    expect(classificar(undefined, LIMITES_PADRAO, AGORA)).toBe("sem_compra");
    expect(classificar("não é data", LIMITES_PADRAO, AGORA)).toBe("sem_compra");
  });

  it("separa as faixas nos prazos, com o limite incluído na faixa de baixo", () => {
    expect(classificar(haDias(0), LIMITES_PADRAO, AGORA)).toBe("ativo");
    expect(classificar(haDias(90), LIMITES_PADRAO, AGORA)).toBe("ativo");
    expect(classificar(haDias(90.01), LIMITES_PADRAO, AGORA)).toBe("pre_inativo");
    expect(classificar(haDias(180), LIMITES_PADRAO, AGORA)).toBe("pre_inativo");
    expect(classificar(haDias(180.01), LIMITES_PADRAO, AGORA)).toBe("inativo");
  });

  it("respeita os prazos da organização", () => {
    const limites = { ativoDias: 30, preInativoDias: 60 };
    expect(classificar(haDias(45), limites, AGORA)).toBe("pre_inativo");
    expect(classificar(haDias(61), limites, AGORA)).toBe("inativo");
  });
});

describe("cortesDaClassificacao", () => {
  it("o corte de consulta concorda com o selo nas bordas", () => {
    const { ativoDesde, preInativoDesde } = cortesDaClassificacao(LIMITES_PADRAO, AGORA);
    // ativo: last_won_at >= ativoDesde
    expect(classificar(ativoDesde, LIMITES_PADRAO, AGORA)).toBe("ativo");
    // pré-inativo: preInativoDesde <= last_won_at < ativoDesde
    expect(classificar(preInativoDesde, LIMITES_PADRAO, AGORA)).toBe("pre_inativo");
    const umMsAntes = new Date(Date.parse(preInativoDesde) - 1).toISOString();
    expect(classificar(umMsAntes, LIMITES_PADRAO, AGORA)).toBe("inativo");
  });
});

describe("limitesDaOrganizacao", () => {
  it("cai no padrão quando falta coluna ou a ordem é inválida", () => {
    expect(limitesDaOrganizacao(null)).toEqual(LIMITES_PADRAO);
    expect(limitesDaOrganizacao({ classificacao_ativo_dias: 60 })).toEqual({ ativoDias: 60, preInativoDias: 180 });
    expect(
      limitesDaOrganizacao({ classificacao_ativo_dias: 200, classificacao_pre_inativo_dias: 100 }),
    ).toEqual(LIMITES_PADRAO);
  });
});
