import { describe, expect, it } from "vitest";
import { diferencaDosVinculos, statusDoVinculo, totalDeMudancas, type MarcaDaEmpresa } from "./vinculos-diff";

describe("diferencaDosVinculos", () => {
  it("separa vincular, trocar papel e desvincular", () => {
    const gravados = [
      { organization_id: "a", role: "agent" as const, revoked_at: null },
      { organization_id: "b", role: "admin" as const, revoked_at: null },
      { organization_id: "c", role: "viewer" as const, revoked_at: "2026-01-01T00:00:00Z" },
    ];
    const tela = new Map<string, MarcaDaEmpresa>([
      ["a", { marcada: true, papel: "manager" }], // troca papel
      ["b", { marcada: false, papel: "admin" }], // desvincula
      ["c", { marcada: true, papel: "agent" }], // revogado volta: vincular
      ["d", { marcada: true, papel: "agent" }], // nova: vincular
      ["e", { marcada: false, papel: "agent" }], // nada
    ]);
    const d = diferencaDosVinculos(gravados, tela);
    expect(Object.fromEntries(d.vincular)).toEqual({ agent: ["c", "d"] });
    expect(d.trocarPapel).toEqual([{ organization_id: "a", role: "manager" }]);
    expect(d.desvincular).toEqual(["b"]);
    expect(totalDeMudancas(d)).toBe(4);
  });

  it("convite pendente NÃO é vínculo ativo: marcar manda vincular, desmarcado não manda nada", () => {
    const gravados = [{ organization_id: "a", role: "admin" as const, revoked_at: null, accepted_at: null }];
    expect(statusDoVinculo(gravados[0]!)).toBe("pendente");

    const marcada = new Map<string, MarcaDaEmpresa>([["a", { marcada: true, papel: "agent" }]]);
    expect(Object.fromEntries(diferencaDosVinculos(gravados, marcada).vincular)).toEqual({ agent: ["a"] });

    const desmarcada = new Map<string, MarcaDaEmpresa>([["a", { marcada: false, papel: "agent" }]]);
    expect(totalDeMudancas(diferencaDosVinculos(gravados, desmarcada))).toBe(0);
  });

  it("statusDoVinculo: revogado vence pendente; sem accepted_at no dado conta como ativo", () => {
    expect(statusDoVinculo({ organization_id: "a", role: "agent", revoked_at: "2026-01-01T00:00:00Z", accepted_at: null })).toBe("revogado");
    expect(statusDoVinculo({ organization_id: "a", role: "agent", revoked_at: null })).toBe("ativo");
    expect(statusDoVinculo({ organization_id: "a", role: "agent", revoked_at: null, accepted_at: "2026-01-01T00:00:00Z" })).toBe("ativo");
  });

  it("sem mudança na tela, nada a mandar", () => {
    const gravados = [{ organization_id: "a", role: "agent" as const, revoked_at: null }];
    const tela = new Map<string, MarcaDaEmpresa>([["a", { marcada: true, papel: "agent" }]]);
    expect(totalDeMudancas(diferencaDosVinculos(gravados, tela))).toBe(0);
  });
});
