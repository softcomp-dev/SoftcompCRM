import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SeloDeClassificacao } from "./SeloDeClassificacao";

describe("SeloDeClassificacao", () => {
  it("mostra o rótulo de cada faixa", () => {
    const casos = [
      ["ativo", "Ativo"],
      ["pre_inativo", "Pré-inativo"],
      ["inativo", "Inativo"],
      ["sem_compra", "Sem compra"],
    ] as const;
    for (const [faixa, rotulo] of casos) {
      const { unmount } = render(<SeloDeClassificacao classificacao={faixa} ultimaVenda={null} />);
      expect(screen.getByTestId(`classificacao-${faixa}`).textContent).toBe(rotulo);
      unmount();
    }
  });

  it("sem classificação da API, não desenha nada", () => {
    const { container } = render(<SeloDeClassificacao classificacao={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});
