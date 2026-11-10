import { describe, expect, it } from "vitest";
import { juntarPorData } from "./juntar";

describe("juntarPorData", () => {
  it("intercala as empresas pela data, carimba a empresa e respeita o limite", () => {
    const r = juntarPorData(
      [
        { organization_id: "A", tem_mais: false, itens: [{ id: "a1", d: "2026-11-10T10:00:00Z" }, { id: "a2", d: "2026-11-08T10:00:00Z" }] },
        { organization_id: "B", tem_mais: false, itens: [{ id: "b1", d: "2026-11-09T10:00:00Z" }, { id: "b2", d: null }] },
      ],
      (i) => i.d,
      3,
    );
    expect(r.itens.map((i) => `${i.organization_id}:${i.id}`)).toEqual(["A:a1", "B:b1", "A:a2"]);
    expect(r.truncado).toBe(true);
  });

  it("avisa truncado quando alguma empresa tinha mais", () => {
    const r = juntarPorData([{ organization_id: "A", tem_mais: true, itens: [] }], () => null, 10);
    expect(r.truncado).toBe(true);
  });
});
