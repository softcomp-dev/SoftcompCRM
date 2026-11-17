import { describe, expect, it } from "vitest";

import { extractChangelogSection } from "../system/changelog";
import { parseFragmento } from "./fragmento";
import { aplicarNoChangelog } from "./montar-secao";
import {
  SEM_FRAGMENTO,
  compararVersoes,
  conferirVersaoNova,
  notasDaRelease,
  secaoDaVersaoDoFork,
  secaoJaEscrita,
  ultimaVersaoDoChangelog,
} from "./versao-do-fork";

/** URL sintética: este arquivo é varrido pela catraca de marca e não nomeia o repo. */
const comparar = (de: string, para: string) => `https://exemplo.test/compare/${de}...${para}`;

function frag(titulo: string, secao = "adicionado") {
  return parseFragmento(
    "x.md",
    ["---", "impacto: capacidade_nova", `secao: ${secao}`, `titulo: ${titulo}`, "---", "", "O corpo da nota."].join("\n"),
  );
}

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Não lançado]",
  "",
  "## [1.104.0] — 2026-11-07",
  "",
  "### Corrigido",
  "",
  "- **Algo do upstream** ...",
  "",
].join("\n");

describe("versão do fork no CHANGELOG", () => {
  it("lê a última versão escrita e compara versões pelo número, não pelo texto", () => {
    expect(ultimaVersaoDoChangelog(CHANGELOG)).toBe("1.104.0");
    expect(compararVersoes("1.104.10", "1.104.9")).toBeGreaterThan(0);
    expect(compararVersoes("1.104.9", "1.104.10")).toBeLessThan(0);
    expect(compararVersoes("1.105.0", "1.104.99")).toBeGreaterThan(0);
    expect(compararVersoes("1.104.3", "1.104.3")).toBe(0);
  });

  it("recusa versão que não anda para a frente, e versão malformada", () => {
    expect(() => conferirVersaoNova("1.104.15", "1.104.0")).not.toThrow();
    expect(() => conferirVersaoNova("1.104.0", "1.104.0")).toThrow(/não é maior/);
    expect(() => conferirVersaoNova("1.103.9", "1.104.0")).toThrow(/não é maior/);
    expect(() => conferirVersaoNova("v1.104.15", "1.104.0")).toThrow(/inválida/);
  });

  it("a seção com fragmentos nasce acima da última versão e a tela da VPS a lê", () => {
    const secao = secaoDaVersaoDoFork([frag("Ganho parcial no funil")], "1.104.15", "2026-11-17");
    const novo = aplicarNoChangelog(CHANGELOG, secao, "1.104.0", comparar);
    expect(ultimaVersaoDoChangelog(novo)).toBe("1.104.15");
    expect(novo.indexOf("## [1.104.15]")).toBeLessThan(novo.indexOf("## [1.104.0]"));
    expect(extractChangelogSection(novo, "1.104.15")?.body).toContain("Ganho parcial no funil");
    expect(novo).toContain("[1.104.15]: https://exemplo.test/compare/v1.104.0...v1.104.15");
  });

  it("sem fragmento a seção existe mesmo assim, e diz que não há nota", () => {
    const secao = secaoDaVersaoDoFork([], "1.104.16", "2026-11-18");
    expect(secao.texto).toBe(`## [1.104.16] — 2026-11-18\n\n${SEM_FRAGMENTO}`);
    const novo = aplicarNoChangelog(CHANGELOG, secao, "1.104.0", comparar);
    expect(ultimaVersaoDoChangelog(novo)).toBe("1.104.16");
  });

  it("o agente do servidor para a leitura no cabeçalho da versão instalada", () => {
    // Mesma régua de hostgator-setup-kit/agent.sh: imprime até a linha que COMEÇA
    // com `## [<instalada>]`, inclusive. Sem a seção da versão instalada, o corte
    // nunca acontece e a tela recebe o arquivo inteiro.
    let changelog = CHANGELOG;
    changelog = aplicarNoChangelog(changelog, secaoDaVersaoDoFork([frag("A")], "1.104.15", "2026-11-17"), "1.104.0", comparar);
    changelog = aplicarNoChangelog(changelog, secaoDaVersaoDoFork([frag("B")], "1.104.16", "2026-11-18"), "1.104.15", comparar);
    const ate = (instalada: string) => {
      const saida: string[] = [];
      for (const linha of changelog.split("\n")) {
        saida.push(linha);
        if (linha.startsWith(`## [${instalada}]`)) break;
      }
      return saida.join("\n");
    };
    const oQueMuda = ate("1.104.15");
    expect(oQueMuda).toContain("**B**");
    expect(oQueMuda).not.toContain("**A**");
  });

  it("as notas da Release são a seção sem o cabeçalho, com o link de comparação", () => {
    const secao = secaoDaVersaoDoFork([frag("Histórico de atendimento")], "1.104.15", "2026-11-17");
    const notas = notasDaRelease(secao, "https://exemplo.test/compare/v1.104.14...v1.104.15");
    expect(notas).not.toContain("## [1.104.15]");
    expect(notas).toContain("Histórico de atendimento");
    expect(notas.trimEnd().endsWith("https://exemplo.test/compare/v1.104.14...v1.104.15")).toBe(true);
  });

  it("reaproveita a seção já escrita quando a execução anterior falhou depois de gravá-la", () => {
    const secao = secaoDaVersaoDoFork([frag("Vínculos")], "1.104.15", "2026-11-17");
    const gravado = aplicarNoChangelog(CHANGELOG, secao, "1.104.0", comparar);
    expect(secaoJaEscrita(gravado, "1.104.15")).toEqual(secao);
    expect(secaoJaEscrita(gravado, "1.104.16")).toBeNull();
    // A última seção do arquivo termina antes do rodapé de links, não nele.
    expect(secaoJaEscrita(gravado, "1.104.0")?.texto).not.toContain("https://exemplo.test");
  });
});
