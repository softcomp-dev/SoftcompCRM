/**
 * A documentação exibida na instalação: lê o arquivo REAL do repositório
 * (`docs/api/openapi.yaml`), troca só nome e servidor, e nada mais.
 */
import { describe, expect, it } from "vitest";

import { especificacaoParaExibir, lerEspecificacao } from "./documentacao";

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

describe("especificacaoParaExibir — entrada inválida", () => {
  it("YAML que não é objeto é recusado com erro, não vira tela vazia", () => {
    expect(() => especificacaoParaExibir("- um\n- dois\n", CONTEXTO)).toThrow(/não é um objeto/);
  });
});
