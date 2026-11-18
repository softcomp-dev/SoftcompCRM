import { describe, expect, it } from "vitest";

import {
  desfechoDosItens,
  faseDoItem,
  podeMudarStatus,
  statusPermitidosNaFase,
  valorVendidoCents,
  type ItemComValor,
} from "./status-do-item";
import { STATUS_DO_ITEM_DA_PROPOSTA, type StatusDoItemDaProposta } from "./tipos";

describe("faseDoItem", () => {
  it("proposta enviada é cotação, seja o negócio cotação, pedido ou sem documento", () => {
    expect(faseDoItem("enviada", "quote")).toBe("cotacao");
    expect(faseDoItem("enviada", "order")).toBe("cotacao");
    expect(faseDoItem("enviada", null)).toBe("cotacao");
  });

  it("proposta aceita só vira pedido quando o negócio foi marcado como pedido", () => {
    expect(faseDoItem("aceita", "order")).toBe("pedido");
    expect(faseDoItem("aceita", "quote")).toBeNull();
    expect(faseDoItem("aceita", null)).toBeNull();
  });

  it("nenhuma outra situação da proposta permite mudar status", () => {
    for (const s of ["rascunho", "enviando", "recusada", "vencida", "cancelada", "substituida"]) {
      expect(faseDoItem(s, "order"), s).toBeNull();
    }
  });
});

describe("podeMudarStatus", () => {
  it("na cotação vale pendente, aceito e recusado, nos dois sentidos", () => {
    expect(podeMudarStatus("cotacao", "pendente", "aceito")).toBe(true);
    expect(podeMudarStatus("cotacao", "pendente", "recusado")).toBe(true);
    expect(podeMudarStatus("cotacao", "aceito", "pendente")).toBe(true);
    expect(podeMudarStatus("cotacao", "recusado", "aceito")).toBe(true);
  });

  it("produção e entrega não existem na cotação", () => {
    expect(podeMudarStatus("cotacao", "aceito", "em_producao")).toBe(false);
    expect(podeMudarStatus("cotacao", "aceito", "entregue")).toBe(false);
  });

  it("no pedido o aceito anda para produção e entrega, e pode ser corrigido", () => {
    expect(podeMudarStatus("pedido", "aceito", "em_producao")).toBe(true);
    expect(podeMudarStatus("pedido", "em_producao", "entregue")).toBe(true);
    expect(podeMudarStatus("pedido", "entregue", "em_producao")).toBe(true);
  });

  it("no pedido o item recusado não volta, e nada volta a pendente", () => {
    expect(podeMudarStatus("pedido", "recusado", "aceito")).toBe(false);
    expect(podeMudarStatus("pedido", "recusado", "em_producao")).toBe(false);
    expect(podeMudarStatus("pedido", "aceito", "recusado")).toBe(false);
    expect(podeMudarStatus("pedido", "aceito", "pendente")).toBe(false);
  });

  it("fora de fase nada muda", () => {
    for (const de of STATUS_DO_ITEM_DA_PROPOSTA) {
      for (const para of STATUS_DO_ITEM_DA_PROPOSTA) {
        expect(podeMudarStatus(null, de, para)).toBe(false);
      }
    }
    expect(statusPermitidosNaFase(null)).toEqual([]);
  });
});

describe("desfechoDosItens", () => {
  it("com algum pendente, ou sem itens, não há desfecho", () => {
    expect(desfechoDosItens([])).toBeNull();
    expect(desfechoDosItens(["aceito", "pendente"])).toBeNull();
  });

  it("todos recusados recusa a proposta", () => {
    expect(desfechoDosItens(["recusado", "recusado"])).toBe("recusada");
  });

  it("pelo menos um aceito aceita a proposta (aceite parcial é aceite)", () => {
    expect(desfechoDosItens(["aceito", "recusado"])).toBe("aceita");
    expect(desfechoDosItens(["aceito", "aceito"])).toBe("aceita");
  });
});

describe("valorVendidoCents", () => {
  const item = (status: StatusDoItemDaProposta, over: Partial<ItemComValor> = {}): ItemComValor => ({
    status, quantidade: 1, preco_unitario_cents: 1000, desconto_cents: 0, ...over,
  });

  it("soma só o aceito e o que veio depois dele", () => {
    expect(
      valorVendidoCents([
        item("aceito"),
        item("em_producao", { quantidade: 2 }),
        item("entregue", { desconto_cents: 500 }),
        item("recusado", { preco_unitario_cents: 99999 }),
        item("pendente", { preco_unitario_cents: 99999 }),
      ]),
    ).toBe(1000 + 2000 + 500);
  });

  it("usa a mesma conta do total: quantidade fracionada arredonda e item sem preço não soma", () => {
    expect(valorVendidoCents([item("aceito", { quantidade: 44.42, preco_unitario_cents: 929 })])).toBe(41266);
    expect(valorVendidoCents([item("aceito", { preco_unitario_cents: null })])).toBe(0);
  });
});
