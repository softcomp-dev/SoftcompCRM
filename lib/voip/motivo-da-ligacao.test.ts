import { describe, expect, it } from "vitest";

import { END_REASON_SEM_AGENTE, motivoDaLigacaoSip } from "./motivo-da-ligacao";

describe("motivoDaLigacaoSip", () => {
  it("traduz o motivo conhecido", () => {
    expect(motivoDaLigacaoSip("timeout")).toBe("O telefone tocou e ninguém atendeu.");
    expect(motivoDaLigacaoSip(END_REASON_SEM_AGENTE)).toMatch(/Nenhum agente de voz/);
  });

  it("não esconde o motivo desconhecido nem fala de WhatsApp", () => {
    expect(motivoDaLigacaoSip("xpto")).toContain("(xpto)");
    expect(motivoDaLigacaoSip(null)).not.toMatch(/WhatsApp/);
  });
});
