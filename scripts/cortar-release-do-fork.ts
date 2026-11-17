/**
 * Corta a seção do CHANGELOG da versão que o FORK acabou de decidir.
 *
 * Quem decide o número é `.github/workflows/versao-automatica-do-fork.yml`
 * (patch + 1 da maior tag); este script só escreve. Casca fina de I/O: as regras
 * moram em `lib/release/versao-do-fork.ts`, que é typechecado e testado
 * (`tsconfig.typecheck.json` exclui `scripts/**`).
 *
 *   pnpm exec tsx scripts/cortar-release-do-fork.ts --versao 1.104.15
 *       # conferência: diz o que escreveria, sem escrever
 *   pnpm exec tsx scripts/cortar-release-do-fork.ts --versao 1.104.15 --escrever --notas /tmp/notas.md
 *       # escreve a seção, apaga os fragmentos consumidos e grava as notas da Release
 *
 * O `scripts/cortar-release.ts` do upstream continua intocado: ele calcula o
 * número pelos fragmentos, e o fork não pode subir minor nem major sozinho.
 */
import fs from "node:fs";
import path from "node:path";

import { parseFragmento } from "../lib/release/fragmento";
import { aplicarNoChangelog } from "../lib/release/montar-secao";
import {
  conferirVersaoNova,
  notasDaRelease,
  secaoDaVersaoDoFork,
  secaoJaEscrita,
  ultimaVersaoDoChangelog,
} from "../lib/release/versao-do-fork";

const RAIZ = path.resolve(__dirname, "..");
const DIR_FRAGMENTOS = path.join(RAIZ, ".changes");
const CHANGELOG = path.join(RAIZ, "CHANGELOG.md");
const REPO = process.env.GITHUB_REPOSITORY || "softcomp-dev/SoftcompCRM";
const compararUrl = (de: string, para: string) => `https://github.com/${REPO}/compare/${de}...${para}`;

function valorDe(argv: readonly string[], nome: string): string | undefined {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : undefined;
}

function hoje(): string {
  // Data de São Paulo: o CI roda em UTC, e uma versão cortada depois das 21h
  // sairia com o dia seguinte.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function main(argv: readonly string[]): number {
  const versao = valorDe(argv, "--versao");
  const notas = valorDe(argv, "--notas");
  const escrever = argv.includes("--escrever");
  if (!versao) {
    process.stderr.write("uso: cortar-release-do-fork.ts --versao X.Y.Z [--escrever] [--notas <arquivo>]\n");
    return 2;
  }

  const changelog = fs.readFileSync(CHANGELOG, "utf8");

  // A execução anterior gravou esta seção e falhou depois (imagens): a tag foi
  // apagada e o número volta. Reaproveita a seção; não consome fragmento novo.
  const escrita = ultimaVersaoDoChangelog(changelog) === versao ? secaoJaEscrita(changelog, versao) : null;
  if (escrita) {
    const versoes = [...changelog.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
    const antes = versoes[1] ?? versao;
    process.stdout.write(`a seção ${versao} já está no CHANGELOG — reaproveitada\n`);
    if (escrever && notas) fs.writeFileSync(notas, notasDaRelease(escrita, compararUrl(`v${antes}`, `v${versao}`)));
    return 0;
  }

  const anterior = ultimaVersaoDoChangelog(changelog);
  conferirVersaoNova(versao, anterior);

  const arquivos = fs.existsSync(DIR_FRAGMENTOS)
    ? fs.readdirSync(DIR_FRAGMENTOS).filter((f) => f.endsWith(".md")).sort()
    : [];
  const fragmentos = arquivos.map((f) => parseFragmento(f, fs.readFileSync(path.join(DIR_FRAGMENTOS, f), "utf8")));
  const secao = secaoDaVersaoDoFork(fragmentos, versao, hoje());

  process.stdout.write(`${anterior} → ${versao}  (${fragmentos.length} fragmento(s))\n`);
  for (const f of fragmentos) process.stdout.write(`  ${f.secao.padEnd(11)} ${f.titulo}\n`);

  if (!escrever) {
    process.stdout.write("\n(conferência: nada foi escrito — use --escrever)\n");
    return 0;
  }

  fs.writeFileSync(CHANGELOG, aplicarNoChangelog(changelog, secao, anterior, compararUrl));
  for (const f of arquivos) fs.rmSync(path.join(DIR_FRAGMENTOS, f));
  if (notas) fs.writeFileSync(notas, notasDaRelease(secao, compararUrl(`v${anterior}`, `v${versao}`)));
  process.stdout.write(`\nCHANGELOG.md com a seção ${versao}; ${arquivos.length} fragmento(s) consumido(s).\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (erro) {
    process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
    process.exit(1);
  }
}
