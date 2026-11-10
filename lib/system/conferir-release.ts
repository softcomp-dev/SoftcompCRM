/**
 * Pergunta ao GitHub, na hora, qual é a última release publicada — o botão
 * "Buscar atualização" de Configurações › Atualização.
 *
 * O agente do host (`agent.sh`) já faz essa pergunta a cada 5 minutos, e ele
 * continua sendo quem diz a VERSÃO INSTALADA. Isto só antecipa a notícia de que
 * saiu release nova: não grava nada, não substitui o agente e não dispara
 * atualização.
 *
 * Mesma pergunta do kit (`ultima_release_estavel`): `/releases/latest`, que o
 * GitHub define como a última que não é draft nem prerelease. O repositório
 * vem do retrato do agente (`release_repo`) e é revalidado aqui; o endereço é
 * montado aqui, nunca recebido — o app não segue URL que veio do host.
 *
 * Cache de 60 s por repositório: a API sem autenticação aceita 60 consultas por
 * hora por IP, e um dedo insistente no botão não pode esgotá-la (o agente usa
 * a mesma cota quando roda no mesmo IP).
 */
import { RELEASE_REPO_FORMA } from "@/lib/system/runtime-identity";

const VERSAO = /^v?\d+\.\d+\.\d+$/;
export const CACHE_DA_CONSULTA_MS = 60_000;
const TEMPO_LIMITE_MS = 10_000;

export type ConsultaDeRelease =
  | { ok: true; release: string; consultado_em: string; do_cache: boolean }
  | { ok: false; motivo: "repositorio_invalido" | "sem_release" | "indisponivel" | "resposta_invalida" };

const cache = new Map<string, { release: string; consultado_em: string; em: number }>();

/** Só para teste: o cache é por processo. */
export function limparCacheDaConsulta(): void {
  cache.clear();
}

export async function consultarUltimaRelease(
  repo: string,
  {
    fetchImpl = fetch,
    agora = () => Date.now(),
  }: { fetchImpl?: typeof fetch; agora?: () => number } = {},
): Promise<ConsultaDeRelease> {
  if (!RELEASE_REPO_FORMA.test(repo)) return { ok: false, motivo: "repositorio_invalido" };

  const guardado = cache.get(repo);
  if (guardado && agora() - guardado.em < CACHE_DA_CONSULTA_MS) {
    return { ok: true, release: guardado.release, consultado_em: guardado.consultado_em, do_cache: true };
  }

  let resposta: Response;
  try {
    resposta = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        // O GitHub recusa chamada sem User-Agent. Nome genérico de propósito:
        // nada de marca no código (tests/unit/branding.test.ts).
        "User-Agent": "crm-update-check",
      },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      cache: "no-store",
    });
  } catch {
    return { ok: false, motivo: "indisponivel" };
  }

  // 404 é "este repositório não tem release publicada" — distinto de "fora do ar".
  if (resposta.status === 404) return { ok: false, motivo: "sem_release" };
  if (!resposta.ok) return { ok: false, motivo: "indisponivel" };

  const corpo = (await resposta.json().catch(() => null)) as { tag_name?: unknown } | null;
  const tag = typeof corpo?.tag_name === "string" ? corpo.tag_name : "";
  if (!VERSAO.test(tag)) return { ok: false, motivo: "resposta_invalida" };

  const consultadoEm = new Date(agora()).toISOString();
  cache.set(repo, { release: tag, consultado_em: consultadoEm, em: agora() });
  return { ok: true, release: tag, consultado_em: consultadoEm, do_cache: false };
}
