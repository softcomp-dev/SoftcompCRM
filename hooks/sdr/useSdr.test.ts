import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { avisoDeNegociosQueFicaram } from "./useSdr";

describe("avisoDeNegociosQueFicaram", () => {
  it("singular para um negócio, plural com o número para vários", () => {
    expect(avisoDeNegociosQueFicaram(1)).toBe(
      "1 negócio aberto continua com essa pessoa. Reatribua pelo campo Responsável no funil.",
    );
    expect(avisoDeNegociosQueFicaram(7)).toBe(
      "7 negócios abertos continuam com essa pessoa. Reatribua pelo campo Responsável no funil.",
    );
  });

  it("as duas frases têm espanhol (a cerca de i18n só enxerga literal dentro de t())", () => {
    expect(
      DICIONARIO["1 negócio aberto continua com essa pessoa. Reatribua pelo campo Responsável no funil."]?.es,
    ).toBeTruthy();
    expect(
      DICIONARIO["{n} negócios abertos continuam com essa pessoa. Reatribua pelo campo Responsável no funil."]?.es,
    ).toBeTruthy();
  });
});
