import { describe, expect, it } from "vitest";
import { diferencaDosVinculos, totalDeMudancas, type MarcaDaEmpresa } from "./vinculos-diff";

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

  it("sem mudança na tela, nada a mandar", () => {
    const gravados = [{ organization_id: "a", role: "agent" as const, revoked_at: null }];
    const tela = new Map<string, MarcaDaEmpresa>([["a", { marcada: true, papel: "agent" }]]);
    expect(totalDeMudancas(diferencaDosVinculos(gravados, tela))).toBe(0);
  });
});
