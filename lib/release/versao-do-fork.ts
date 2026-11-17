/**
 * A SEÇÃO DO CHANGELOG DE UMA VERSÃO DO FORK — as regras puras.
 *
 * O fork corta versão a cada push com código na `main`
 * (`.github/workflows/versao-automatica-do-fork.yml`), e o número é decidido lá:
 * sobe só o PATCH da maior tag, para a próxima versão do upstream continuar maior.
 * Por isso o fork não usa `calcularBump` — o número chega pronto — mas usa o
 * mesmo montador de seção (`montar-secao.ts`) e o mesmo parser de fragmento.
 *
 * Por que a seção precisa existir: o agente do servidor tira do CHANGELOG da tag
 * o quadro "o que muda ao atualizar" (`hostgator-setup-kit/agent.sh`, leitura
 * até o cabeçalho da versão instalada). Sem a seção, quem atualiza o servidor do
 * fork não vê nada do que mudou, e os fragmentos de `.changes/` se acumulam sem
 * nunca virar nota.
 *
 * Módulo PURO: recebe texto, devolve texto. Quem toca disco é
 * `scripts/cortar-release-do-fork.ts`.
 */
import type { Fragmento } from "./fragmento";
import { type SecaoMontada, montarSecao } from "./montar-secao";

const VERSAO = /^(\d+)\.(\d+)\.(\d+)$/;

/** A primeira `## [X.Y.Z]` do arquivo — a última versão escrita nele. */
export function ultimaVersaoDoChangelog(changelog: string): string {
  for (const linha of changelog.split("\n")) {
    const m = /^##\s+\[(\d+\.\d+\.\d+)\]/.exec(linha);
    if (m?.[1]) return m[1];
  }
  throw new Error("CHANGELOG.md sem nenhuma seção `## [X.Y.Z]`");
}

function partes(versao: string): [number, number, number] {
  const m = VERSAO.exec(versao);
  if (!m) throw new Error(`versão inválida: "${versao}" (esperado X.Y.Z)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negativo se `a < b`, zero se iguais, positivo se `a > b`. */
export function compararVersoes(a: string, b: string): number {
  const [A, B] = [partes(a), partes(b)];
  return A[0] - B[0] || A[1] - B[1] || A[2] - B[2];
}

/**
 * Recusa a versão que não anda para a frente. Escrever `## [1.104.3]` acima de
 * `## [1.104.14]` faria o agente do servidor parar a leitura no cabeçalho errado.
 */
export function conferirVersaoNova(nova: string, ultimaNoChangelog: string): void {
  if (compararVersoes(nova, ultimaNoChangelog) <= 0) {
    throw new Error(
      `a versão ${nova} não é maior que a última do CHANGELOG (${ultimaNoChangelog})`,
    );
  }
}

/** O texto da versão que saiu sem fragmento: diz isso, em vez de inventar nota. */
export const SEM_FRAGMENTO =
  "Esta versão não trouxe fragmento em `.changes/`: as mudanças não foram descritas para quem opera.";

/**
 * A seção da versão. Com fragmentos, é o montador de sempre. Sem nenhum — push
 * de código que não trouxe fragmento —, a seção existe mesmo assim, curta e
 * honesta: sem ela o agente não acharia o cabeçalho da versão instalada na
 * próxima atualização e mostraria o arquivo inteiro como "o que muda".
 */
export function secaoDaVersaoDoFork(
  fragmentos: readonly Fragmento[],
  versao: string,
  data: string,
): SecaoMontada {
  partes(versao);
  if (fragmentos.length > 0) return montarSecao(fragmentos, versao, data);
  return { versao, texto: `## [${versao}] — ${data}\n\n${SEM_FRAGMENTO}` };
}

/** As notas da Release: a seção sem o cabeçalho (o título da Release já é a versão). */
export function notasDaRelease(secao: SecaoMontada, compararUrl: string): string {
  const corpo = secao.texto.split("\n").slice(1).join("\n").trim();
  return `${corpo}\n\n**Comparar:** ${compararUrl}\n`;
}

/**
 * A seção que JÁ está no CHANGELOG para esta versão — o caso da execução que
 * gravou a seção na `main` e depois falhou na publicação das imagens (a tag é
 * apagada, a seção fica). A execução seguinte pede o MESMO número: em vez de
 * recusar e travar o fork, reaproveita a seção escrita para montar as notas.
 */
export function secaoJaEscrita(changelog: string, versao: string): SecaoMontada | null {
  const linhas = changelog.split("\n");
  const inicio = linhas.findIndex((l) => l.startsWith(`## [${versao}]`));
  if (inicio < 0) return null;
  let fim = linhas.length;
  for (let i = inicio + 1; i < linhas.length; i++) {
    if (/^##\s+\[/.test(linhas[i]!) || /^\[[^\]]+\]:\s+\S+$/.test(linhas[i]!)) {
      fim = i;
      break;
    }
  }
  return { versao, texto: linhas.slice(inicio, fim).join("\n").trimEnd() };
}
