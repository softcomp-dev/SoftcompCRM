import { describe, expect, it } from "vitest";
import { empresasDoEscopo, lerEmpresasDaUrl, type EmpresaDoEscopo } from "./escopo";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ALHEIA = "99999999-9999-4999-8999-999999999999";

const vinculos: EmpresaDoEscopo[] = [
  { organization_id: A, nome: "Loja A", role: "admin" },
  { organization_id: B, nome: "Loja B", role: "agent" },
];

describe("empresasDoEscopo", () => {
  it("sem filtro: todas as empresas da pessoa", () => {
    expect(empresasDoEscopo(vinculos, []).map((e) => e.organization_id)).toEqual([A, B]);
  });
  it("com filtro: só as pedidas que são dela", () => {
    expect(empresasDoEscopo(vinculos, [B]).map((e) => e.organization_id)).toEqual([B]);
  });
  it("empresa alheia no filtro nunca entra", () => {
    expect(empresasDoEscopo(vinculos, [B, ALHEIA]).map((e) => e.organization_id)).toEqual([B]);
    // Só alheias pedidas: volta para as dela, sem confirmar nada sobre a alheia.
    expect(empresasDoEscopo(vinculos, [ALHEIA]).map((e) => e.organization_id)).toEqual([A, B]);
  });
});

describe("lerEmpresasDaUrl", () => {
  it("aceita ids separados por vírgula, sem repetir, e descarta lixo", () => {
    expect(lerEmpresasDaUrl(`${A},${A}, ${B},x;drop`)).toEqual([A, B]);
    expect(lerEmpresasDaUrl(null)).toEqual([]);
  });
});
