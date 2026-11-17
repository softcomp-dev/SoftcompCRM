// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { aplicarMarcaNaPagina, cssDaMarca, lerMarca, tipoDoLogo } from "./marca";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
const pagina = readFileSync("curso/site/pagina.html", "utf8");

describe("marca do site do curso", () => {
  it("sem parâmetro nenhum, o site sai como sempre", () => {
    const marca = lerMarca({}, () => PNG);
    expect(marca).toEqual({ nome: null, cor: null, logo: null });
    expect(cssDaMarca(marca.cor)).toBe("");
    const html = aplicarMarcaNaPagina(pagina, marca);
    expect(html).toContain("<title>Curso DeskComm</title>");
    expect(html).toContain('<span class="marca-nome">DeskComm</span>');
    expect(html).toContain('class="marca-d"');
    expect(html).not.toContain("{{MARCA}}");
  });

  it("nome, cor e logo trocam título, cabeçalho e as variáveis de cor nos dois temas", () => {
    const marca = lerMarca(
      { CURSO_MARCA: " SoftcompCRM ", CURSO_MARCA_COR: "#505456", CURSO_MARCA_LOGO: "/logo.png" },
      () => PNG,
    );
    expect(marca.nome).toBe("SoftcompCRM");
    expect(marca.logo?.startsWith("data:image/png;base64,")).toBe(true);
    const html = aplicarMarcaNaPagina(pagina, marca);
    expect(html).toContain("<title>Curso SoftcompCRM</title>");
    expect(html).toContain('class="marca-logo"');
    expect(html).toContain('alt="SoftcompCRM"');
    expect(html).not.toContain('class="marca-d"');
    const css = cssDaMarca(marca.cor);
    expect(css).toContain("--oliva: #505456;");
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("logo é conferido pelos bytes e pelo tamanho; cor inválida é recusada", () => {
    expect(tipoDoLogo(PNG)).toBe("image/png");
    expect(tipoDoLogo(JPG)).toBe("image/jpeg");
    expect(tipoDoLogo(SVG)).toBeNull();
    expect(() => lerMarca({ CURSO_MARCA_LOGO: "/x.png" }, () => SVG)).toThrow(/PNG ou JPEG/);
    expect(() => lerMarca({ CURSO_MARCA_LOGO: "/x.png" }, () => new Uint8Array(512 * 1024 + 1))).toThrow(/512 KB/);
    expect(() => lerMarca({ CURSO_MARCA_COR: "cinza" }, () => PNG)).toThrow(/#RRGGBB/);
  });

  it("o nome entra escapado no HTML", () => {
    const html = aplicarMarcaNaPagina(pagina, { nome: 'A&B "<x>"', cor: null, logo: null });
    expect(html).toContain("<title>Curso A&amp;B &quot;&lt;x&gt;&quot;</title>");
  });
});
