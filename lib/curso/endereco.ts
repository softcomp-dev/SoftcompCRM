/**
 * O ENDEREÇO DO CURSO ILUSTRADO DENTRO DO CRM (tela /app/curso).
 *
 * O curso é publicado FORA da imagem do app — as fotos dos dois idiomas passam
 * de 100 MB, e pô-las na imagem ou no git faria cada recaptura engordar os dois.
 * A tela só aponta para onde ele está publicado (`CURSO_URL`): o português na
 * raiz e o espanhol em `es/`, a mesma estrutura que `curso/montar.ts` gera com
 * `CURSO_BASE`.
 *
 * Puro: quem lê o ambiente é a página.
 */

/** Os idiomas que o curso tem — os mesmos que a interface oferece hoje. */
export type IdiomaDoCurso = "pt-BR" | "es";

/** O idioma da pessoa vira o do curso; o que o curso não tem cai no português. */
export function idiomaDoCurso(idiomaDaPessoa: string | null | undefined): IdiomaDoCurso {
  return idiomaDaPessoa === "es" ? "es" : "pt-BR";
}

/**
 * O endereço do curso no idioma pedido, ou `null` quando a instalação não tem
 * curso (variável vazia): a tela diz isso em vez de abrir uma página em branco.
 */
export function enderecoDoCurso(base: string, idioma: IdiomaDoCurso): string | null {
  const limpa = base.trim();
  if (limpa === "") return null;
  const comBarra = limpa.endsWith("/") ? limpa : `${limpa}/`;
  return idioma === "es" ? `${comBarra}es/` : comBarra;
}
