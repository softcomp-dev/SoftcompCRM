/**
 * A MARCA DO SITE DO CURSO — nome, cor e logo, por parâmetro do montador.
 *
 *   CURSO_MARCA=SoftcompCRM CURSO_MARCA_COR=#505456 \
 *   CURSO_MARCA_LOGO=/caminho/logo.png pnpm exec tsx curso/montar.ts
 *
 * Sem nenhum deles o site sai exatamente como sempre (DeskComm, o verde do
 * curso e o símbolo "D"). Assim o mesmo montador serve o curso do produto e o
 * de quem instala com outra marca, sem cópia do site por marca.
 *
 * A marca das FOTOS é outra camada: ela vem da instalação fotografada
 * (`semear-demonstracao.ts`, `CURSO_MARCA_*` aplicados como marca da
 * instalação). Este módulo cuida só da página que envolve as fotos.
 *
 * Puro: quem lê disco e ambiente é o montador.
 */

/** O que o site do curso usa da marca. Tudo opcional: ausente é o padrão de hoje. */
export interface MarcaDoCurso {
  nome: string | null;
  cor: string | null;
  /** O logo como data URI: o pacote publicado leva só `index.html` e `capturas/`. */
  logo: string | null;
}

/** O mesmo teto da tela Marca do produto (`/api/v1/marca/logo`). */
export const TETO_DO_LOGO = 512 * 1024;

const HEX = /^#[0-9a-f]{6}$/i;

/** PNG ou JPEG pelos BYTES, como o produto: renomear um SVG para .png não passa. */
export function tipoDoLogo(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export function lerMarca(
  env: { CURSO_MARCA?: string; CURSO_MARCA_COR?: string; CURSO_MARCA_LOGO?: string },
  lerArquivo: (caminho: string) => Uint8Array,
): MarcaDoCurso {
  const nome = env.CURSO_MARCA?.trim() || null;
  const corBruta = env.CURSO_MARCA_COR?.trim() || null;
  if (corBruta && !HEX.test(corBruta)) {
    throw new Error(`CURSO_MARCA_COR precisa ser uma cor #RRGGBB (veio "${corBruta}")`);
  }
  let logo: string | null = null;
  const caminho = env.CURSO_MARCA_LOGO?.trim();
  if (caminho) {
    const bytes = lerArquivo(caminho);
    if (bytes.length > TETO_DO_LOGO) throw new Error(`CURSO_MARCA_LOGO passa de 512 KB (${bytes.length} bytes)`);
    const tipo = tipoDoLogo(bytes);
    if (!tipo) throw new Error("CURSO_MARCA_LOGO precisa ser PNG ou JPEG (conferido pelos bytes)");
    logo = `data:${tipo};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  return { nome, cor: corBruta ? corBruta.toLowerCase() : null, logo };
}

/**
 * A cor da marca nos dois temas, por cima das variáveis `--oliva*` do site.
 * No escuro a cor clareia, para o texto e os botões continuarem legíveis.
 */
export function cssDaMarca(cor: string | null): string {
  if (!cor) return "";
  const escuro =
    `--oliva: color-mix(in srgb, ${cor} 45%, white); ` +
    `--oliva-forte: color-mix(in srgb, ${cor} 30%, white); ` +
    `--oliva-suave: color-mix(in srgb, ${cor} 35%, transparent); --sobre-oliva: #161510;`;
  return [
    `:root { --oliva: ${cor}; --oliva-forte: color-mix(in srgb, ${cor} 82%, black); ` +
      `--oliva-suave: color-mix(in srgb, ${cor} 14%, white); --sobre-oliva: #ffffff; }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${escuro} } }`,
    `:root[data-theme="dark"] { ${escuro} }`,
  ].join("\n");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SIMBOLO_E_NOME =
  '<span class="marca-d" aria-hidden="true">D</span>\n      <span class="marca-nome">{{MARCA}}</span>';

/** Nome no título e no cabeçalho; com logo, a imagem toma o lugar do símbolo e do nome. */
export function aplicarMarcaNaPagina(html: string, marca: MarcaDoCurso): string {
  const nome = escHtml(marca.nome ?? "DeskComm");
  let saida = html;
  if (marca.logo) {
    if (!saida.includes(SIMBOLO_E_NOME)) throw new Error("pagina.html sem o símbolo e o nome da marca no cabeçalho");
    saida = saida.replace(SIMBOLO_E_NOME, () => `<img class="marca-logo" src="${marca.logo}" alt="${nome}">`);
  }
  return saida.split("{{MARCA}}").join(nome);
}
