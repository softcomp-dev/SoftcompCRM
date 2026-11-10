/**
 * A documentação exibida na instalação: lê o arquivo REAL do repositório
 * (`docs/api/openapi.yaml`), troca só nome e servidor, e nada mais.
 */
import { describe, expect, it } from "vitest";

import {
  CAMINHO_DA_ESPECIFICACAO,
  especificacaoParaExibir,
  lerEspecificacao,
} from "./documentacao";

const CONTEXTO = { nome: "Minha Marca", origem: "https://crm.cliente.com.br/" };

describe("especificacaoParaExibir — com o arquivo real", () => {
  it("o arquivo do repositório é lido e vira um OpenAPI 3.1 com as rotas", async () => {
    const spec = especificacaoParaExibir(await lerEspecificacao(), CONTEXTO);

    expect(spec.openapi).toBe("3.1.0");
    const paths = spec.paths as Record<string, unknown>;
    // As rotas REST de funil e card precisam estar na tela.
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/pipelines",
        "/api/v1/pipelines/{id}/stages",
        "/api/v1/leads",
        "/api/v1/leads/{id}/move",
        "/api/mcp",
      ]),
    );
  });

  it("o título é o da marca, e o nome do produto não aparece em info", async () => {
    const spec = especificacaoParaExibir(await lerEspecificacao(), CONTEXTO);
    const info = spec.info as Record<string, unknown>;

    expect(info.title).toBe("Minha Marca — API para integrações");
    // O contato do arquivo nomeia o produto: sai inteiro.
    expect(info.contact).toBeUndefined();
  });

  it("o servidor é esta instalação, sem barra no fim (senão o caminho vira //api)", async () => {
    const spec = especificacaoParaExibir(await lerEspecificacao(), CONTEXTO);

    expect(spec.servers).toEqual([
      { url: "https://crm.cliente.com.br", description: "Esta instalação" },
    ]);
  });

  it("não altera o resto: o objeto de entrada fica intacto e as rotas são as mesmas", async () => {
    const yaml = await lerEspecificacao();
    const a = especificacaoParaExibir(yaml, CONTEXTO);
    const b = especificacaoParaExibir(yaml, { nome: "Outra", origem: "http://10.0.0.1:8000" });

    expect(a.paths).toEqual(b.paths);
    expect(a.components).toEqual(b.components);
  });
});

/**
 * O arquivo precisa estar DENTRO DA IMAGEM, e quem decide isso é o
 * `.dockerignore` — que exclui `docs/` inteira. Na v1.104.3 a tela respondeu
 * 500 em produção com o build local verde: o `next build` fora do Docker não
 * passa pelo `.dockerignore`. A regra abaixo é a do Docker: cada linha que casa
 * o caminho (ou uma pasta acima dele) decide, e a ÚLTIMA vence; `!` reinclui.
 */
describe("a especificação entra na imagem Docker", () => {
  function padraoParaRegex(padrao: string): RegExp {
    const corpo = padrao
      .replace(/^\/+/, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, ".*");
    return new RegExp(`^${corpo}$`);
  }

  function excluidoDaImagem(caminho: string, dockerignore: string): boolean {
    const partes = caminho.split("/");
    const alvos = partes.map((_, i) => partes.slice(0, i + 1).join("/"));
    let excluido = false;
    for (const bruta of dockerignore.split(/\r?\n/)) {
      const linha = bruta.trim();
      if (!linha || linha.startsWith("#")) continue;
      const nega = linha.startsWith("!");
      const regex = padraoParaRegex(nega ? linha.slice(1) : linha);
      if (alvos.some((a) => regex.test(a))) excluido = !nega;
    }
    return excluido;
  }

  it("docs/api/openapi.yaml não é excluído pelo .dockerignore", async () => {
    const { readFile } = await import("node:fs/promises");
    const dockerignore = await readFile(".dockerignore", "utf8");

    expect(excluidoDaImagem(CAMINHO_DA_ESPECIFICACAO, dockerignore)).toBe(false);
  });

  it("controle: o resto de docs/ continua fora da imagem", async () => {
    const { readFile } = await import("node:fs/promises");
    const dockerignore = await readFile(".dockerignore", "utf8");

    expect(excluidoDaImagem("docs/index.md", dockerignore)).toBe(true);
    expect(excluidoDaImagem("docs/api/outro.yaml", dockerignore)).toBe(true);
  });
});

describe("especificacaoParaExibir — entrada inválida", () => {
  it("YAML que não é objeto é recusado com erro, não vira tela vazia", () => {
    expect(() => especificacaoParaExibir("- um\n- dois\n", CONTEXTO)).toThrow(/não é um objeto/);
  });
});
