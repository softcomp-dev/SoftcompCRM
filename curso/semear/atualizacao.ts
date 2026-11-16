/**
 * Semente do módulo Atualização do sistema: a instalação está numa versão
 * publicada e o servidor já avisou que saiu a seguinte. A versão instalada é a
 * anterior à das fotos, e a nova é a das fotos, com o trecho REAL do
 * CHANGELOG.md entre as duas: o "O que muda" da foto é o que de fato mudou.
 *
 * O pedido que a aula faz pelo botão "Atualizar agora" fica numa fila que só o
 * agente do servidor lê, e a bancada não tem agente. A base apaga o pedido antes de cada aula.
 *
 * O botão "Buscar atualização" só aparece quando o retrato do agente traz
 * `release_repo` (app/api/v1/system/version/route.ts: `release_check_available`).
 * A base grava o retrato sem ele, então a semente acrescenta o campo. O valor é
 * de enfeite: a aula só FOTOGRAFA o botão e nunca o clica, porque o clique sai
 * para o GitHub de verdade (/api/v1/system/version/latest-release).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Contexto, confirmarVersaoDaInstalacao, semErro, versaoDasFotos } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  const nova = versaoDasFotos();
  const changelog = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "CHANGELOG.md"), "utf8");
  // a seção da versão das fotos e a anterior: a anterior é a instalada
  const secoes = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)];
  const i = secoes.findIndex((m) => m[1] === nova);
  const anterior = secoes[i + 1];
  if (i < 0 || !anterior) throw new Error(`CHANGELOG.md sem as seções ${nova} e a anterior`);
  const trecho = changelog.slice(secoes[i]!.index, secoes[i + 2]?.index ?? changelog.length);
  await confirmarVersaoDaInstalacao(anterior[1], nova, trecho);
  const { data } = await c.db.from("system_version").select("runtime_confirmation").eq("id", 1).single();
  const retrato = (data?.runtime_confirmation ?? {}) as Record<string, unknown>;
  semErro(
    await c.db
      .from("system_version")
      .update({ runtime_confirmation: { ...retrato, release_repo: "exemplo/crm" } } as never)
      .eq("id", 1),
    "repositório das releases",
  );
  console.info(`atualizacao: instalada ${anterior[1]}, nova ${nova}`);
}
