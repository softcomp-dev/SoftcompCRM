import { describe, expect, it } from "vitest";
import {
  CHAVE_GANHO,
  CHAVE_PERDIDO,
  escolherFunis,
  etapaDeDestino,
  montarColunas,
  nomesDeFunil,
  normalizarNomeDaEtapa,
  type EtapaDoFunil,
} from "./colunas";

function etapa(
  id: string,
  org: string,
  pipe: string,
  name: string,
  position: number,
  extra: Partial<EtapaDoFunil> = {},
): EtapaDoFunil {
  return { id, organization_id: org, pipeline_id: pipe, name, position, is_won: false, is_lost: false, ...extra };
}

describe("montarColunas", () => {
  const etapas = [
    etapa("a1", "A", "pa", "Novo", 1),
    etapa("a2", "A", "pa", "Proposta", 2),
    etapa("a3", "A", "pa", "Ganho", 3, { is_won: true }),
    etapa("a4", "A", "pa", "Perdido", 4, { is_lost: true }),
    etapa("b1", "B", "pb", "novo", 1),
    etapa("b2", "B", "pb", "Visita", 2),
    etapa("b3", "B", "pb", "PROPOSTA", 3),
    etapa("b4", "B", "pb", "Fechado", 4, { is_won: true }),
    etapa("b5", "B", "pb", "Cancelado", 5, { is_lost: true }),
  ];

  it("junta etapas de mesmo nome e mantém a exclusiva como coluna própria", () => {
    const colunas = montarColunas(etapas);
    expect(colunas.map((c) => c.chave)).toEqual(["novo", "visita", "proposta", CHAVE_GANHO, CHAVE_PERDIDO]);
    const novo = colunas.find((c) => c.chave === "novo")!;
    expect(novo.etapas.map((e) => e.stage_id).sort()).toEqual(["a1", "b1"]);
    expect(colunas.find((c) => c.chave === "visita")!.etapas).toHaveLength(1);
  });

  it("junta ganho e perda pela marca, não pelo nome", () => {
    const colunas = montarColunas(etapas);
    const ganho = colunas.find((c) => c.chave === CHAVE_GANHO)!;
    expect(ganho.tipo).toBe("ganho");
    expect(ganho.etapas.map((e) => e.stage_id).sort()).toEqual(["a3", "b4"]);
    expect(colunas.at(-1)!.tipo).toBe("perdido");
  });

  it("destino do arrasto é a etapa do MESMO funil do card", () => {
    const colunas = montarColunas(etapas);
    const proposta = colunas.find((c) => c.chave === "proposta")!;
    expect(etapaDeDestino(proposta, "pa")).toBe("a2");
    expect(etapaDeDestino(proposta, "pb")).toBe("b3");
    const visita = colunas.find((c) => c.chave === "visita")!;
    expect(etapaDeDestino(visita, "pa")).toBeNull();
  });
});

describe("normalizarNomeDaEtapa", () => {
  it("ignora acento, maiúscula e espaço repetido", () => {
    expect(normalizarNomeDaEtapa("  Negociação   Final ")).toBe("negociacao final");
  });
});

describe("escolherFunis", () => {
  const funis = [
    { id: "f1", organization_id: "A", name: "Vendas", is_default: false, position: 1 },
    { id: "f2", organization_id: "A", name: "Pedidos", is_default: true, position: 2 },
    { id: "f3", organization_id: "B", name: "vendas", is_default: false, position: 1 },
  ];
  it("padrão: o default de cada empresa, ou o primeiro", () => {
    expect(escolherFunis(funis, "padrao").map((f) => f.id).sort()).toEqual(["f2", "f3"]);
  });
  it("por nome: o funil com esse nome em cada empresa que o tem", () => {
    expect(escolherFunis(funis, "vendas").map((f) => f.id).sort()).toEqual(["f1", "f3"]);
    expect(escolherFunis(funis, "pedidos").map((f) => f.id)).toEqual(["f2"]);
  });
  it("oferece os nomes sem repetir, o mais comum primeiro", () => {
    expect(nomesDeFunil(funis).map((n) => [n.chave, n.empresas])).toEqual([
      ["vendas", 2],
      ["pedidos", 1],
    ]);
  });
});
