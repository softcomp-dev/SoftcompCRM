import { describe, expect, it } from "vitest";

import { enderecoDoCurso } from "./endereco";

describe("endereço do curso dentro do CRM", () => {
  it("normaliza a barra final", () => {
    expect(enderecoDoCurso("https://exemplo.test/curso")).toBe("https://exemplo.test/curso/");
    expect(enderecoDoCurso(" https://exemplo.test/curso/ ")).toBe("https://exemplo.test/curso/");
  });

  it("sem endereço a instalação não tem curso", () => {
    expect(enderecoDoCurso("")).toBeNull();
    expect(enderecoDoCurso("   ")).toBeNull();
  });
});
