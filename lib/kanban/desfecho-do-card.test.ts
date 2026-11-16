import { describe, expect, it } from "vitest";

import { CORES_DO_DESFECHO, desfechoDoCard, rotuloDoDesfecho } from "./desfecho-do-card";

describe("desfecho do card", () => {
  it("aberto não tem desfecho — fica com a borda de estado", () => {
    expect(desfechoDoCard({ status: "open" })).toBeNull();
  });

  it("ganho, perdido e parcial têm cada um a sua cor", () => {
    expect(desfechoDoCard({ status: "won" })).toBe("ganho");
    expect(desfechoDoCard({ status: "won", is_partial_win: false })).toBe("ganho");
    expect(desfechoDoCard({ status: "won", is_partial_win: true })).toBe("parcial");
    expect(desfechoDoCard({ status: "lost" })).toBe("perdido");
    const faixas = new Set(Object.values(CORES_DO_DESFECHO).map((c) => c.faixa));
    expect(faixas.size).toBe(3);
  });

  it("a marca de parcial num negócio que não é ganho não pinta de parcial", () => {
    // O gatilho do banco limpa a marca ao sair do ganho; a tela não confia só nele.
    expect(desfechoDoCard({ status: "open", is_partial_win: true })).toBeNull();
    expect(desfechoDoCard({ status: "lost", is_partial_win: true })).toBe("perdido");
  });

  it("o rótulo nomeia o desfecho", () => {
    const t = (s: string) => s;
    expect(rotuloDoDesfecho("parcial", t)).toBe("Ganho parcial");
    expect(rotuloDoDesfecho("ganho", t)).toBe("Ganho");
    expect(rotuloDoDesfecho("perdido", t)).toBe("Perdido");
  });
});
