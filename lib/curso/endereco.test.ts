import { describe, expect, it } from "vitest";

import { enderecoDoCurso, idiomaDoCurso } from "./endereco";

describe("endereço do curso dentro do CRM", () => {
  it("o idioma da pessoa escolhe o do curso, e o resto cai no português", () => {
    expect(idiomaDoCurso("es")).toBe("es");
    expect(idiomaDoCurso("pt-BR")).toBe("pt-BR");
    expect(idiomaDoCurso("en")).toBe("pt-BR");
    expect(idiomaDoCurso(null)).toBe("pt-BR");
  });

  it("português na raiz e espanhol em es/, com ou sem a barra final", () => {
    expect(enderecoDoCurso("https://exemplo.test/curso", "pt-BR")).toBe("https://exemplo.test/curso/");
    expect(enderecoDoCurso("https://exemplo.test/curso/", "es")).toBe("https://exemplo.test/curso/es/");
  });

  it("sem endereço a instalação não tem curso", () => {
    expect(enderecoDoCurso("", "pt-BR")).toBeNull();
    expect(enderecoDoCurso("   ", "es")).toBeNull();
  });
});
