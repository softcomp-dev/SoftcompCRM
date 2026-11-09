/**
 * A documentação OpenAPI da API, preparada para ser exibida DENTRO de uma
 * instalação (tela `/app/docs`).
 *
 * A fonte é uma só: `docs/api/openapi.yaml`, o mesmo arquivo que um integrador
 * lê no repositório. Exibida na instalação, ela muda em dois pontos, e só neles:
 *
 * - **Nome.** O arquivo traz o nome do produto; numa instalação de marca própria
 *   quem lê é cliente do revendedor, e a tela mostra a marca resolvida
 *   (`marcaDaSaida`), nunca o nome do produto (`tests/unit/branding.test.ts`).
 * - **Servidor.** O arquivo traz um domínio de exemplo; aqui o "Testar" do
 *   Swagger precisa chamar ESTA instalação, pelo endereço público dela.
 *
 * Os nomes de cabeçalho (`X-Deskcomm-Signature` e afins) NÃO são trocados: são
 * contrato da API e não mudam com a marca (`docs/integracao/webhooks-de-saida.md`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { load } from "js-yaml";

/** Caminho do arquivo, relativo à raiz do app (vale no `next start` e no standalone). */
export const CAMINHO_DA_ESPECIFICACAO = "docs/api/openapi.yaml";

export interface ContextoDaExibicao {
  /** Nome da marca resolvida para quem está vendo. */
  nome: string;
  /** Endereço público da instalação (`NEXT_PUBLIC_APP_URL`). */
  origem: string;
}

type Especificacao = Record<string, unknown> & {
  info?: Record<string, unknown>;
};

/** Lê o arquivo da especificação. Lança se ele não estiver no disco. */
export async function lerEspecificacao(raiz: string = process.cwd()): Promise<string> {
  return readFile(path.join(raiz, CAMINHO_DA_ESPECIFICACAO), "utf8");
}

/**
 * Converte o YAML no objeto que o Swagger exibe, com nome e servidor desta
 * instalação. Função pura: recebe o texto, devolve um objeto novo.
 */
export function especificacaoParaExibir(
  yaml: string,
  { nome, origem }: ContextoDaExibicao,
): Especificacao {
  const lido = load(yaml);
  if (!lido || typeof lido !== "object" || Array.isArray(lido)) {
    throw new Error("A especificação OpenAPI não é um objeto YAML.");
  }
  const spec = lido as Especificacao;
  const info = { ...(spec.info ?? {}) };

  info.title = `${nome} — API para integrações`;
  // O contato do arquivo nomeia o produto; numa instalação, quem responde pela
  // API é quem a opera, e a tela não tem como saber quem é. Sai.
  delete info.contact;

  return {
    ...spec,
    info,
    servers: [{ url: origem.replace(/\/+$/, ""), description: "Esta instalação" }],
  };
}
