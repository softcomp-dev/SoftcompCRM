/**
 * O ENDEREÇO DO CURSO ILUSTRADO DENTRO DO CRM (tela /app/curso).
 *
 * O curso é publicado FORA da imagem do app — as fotos passam de 50 MB, e
 * pô-las na imagem ou no git faria cada recaptura engordar os dois. A tela só
 * aponta para onde ele está publicado (`CURSO_URL`).
 *
 * Só em português, por decisão do dono do fork (17/11/2026): a interface em
 * espanhol abre o mesmo curso. O catálogo de espanhol do curso continua no
 * repositório, para um idioma novo ser só uma rodada de captura.
 *
 * Puro: quem lê o ambiente é a página.
 */

/**
 * O endereço do curso, ou `null` quando a instalação não tem curso (variável
 * vazia): a tela diz isso em vez de abrir uma página em branco.
 */
export function enderecoDoCurso(base: string): string | null {
  const limpa = base.trim();
  if (limpa === "") return null;
  return limpa.endsWith("/") ? limpa : `${limpa}/`;
}
