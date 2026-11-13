/**
 * O que as rotas de regra de automação devem a quem chama por TOKEN (`dsk_…`).
 *
 * A regra guarda URL e segredo de webhook, então o ramo do token é mais
 * estreito que o da sessão em três pontos — todos aqui, para as três rotas
 * (`route.ts`, `[id]/route.ts`) dizerem o mesmo:
 *
 *  1. PAPEL `admin` (a sessão pede `manager`): é a decisão do mapa
 *     `docs/api/integracao-erp.md` item 9 — o token é credencial de servidor,
 *     de longa vida, e a regra decide para onde a empresa manda dados.
 *  2. O SEGREDO nunca volta: `secret_enc` (cifra at-rest) sai da resposta, e o
 *     que a tela devolve em round-trip vira `secret_configured`. O que o
 *     cliente mande como `secret_enc` é descartado — o ciphertext só nasce
 *     da cifra do servidor, nunca de fora.
 *  3. A URL é conferida na ESCRITA com o mesmo guard textual que o executor usa
 *     (`assertSafeOutboundUrl`). O executor (`call-webhook.ts`) continua sendo
 *     a barreira de verdade — inclusive a resolução de DNS —, mas um servidor
 *     sem tela não tem quem veja o erro de uma regra que nunca dispara.
 */
import { ApiError } from "@/lib/api/types";
import { falhaDoHandlerParaToken } from "@/lib/api/integracao-por-token";
import type { AuthDual } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import type { Role } from "@/lib/auth/types";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

/** Papel mínimo do token nas três rotas (a sessão segue `manager`). */
export const PAPEL_DO_TOKEN: Role = "admin";

type Acao = { type: string; config?: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function chaveInvalida(chave: string | null): boolean {
  return chave !== null && !UUID.test(chave);
}

/** `ai_agent` por token não escreve regra: o MCP recusa "de propósito", e a REST não é atalho. */
export function recusaDeAgenteDeIa(
  authz: Extract<AuthDual, { ok: true }>,
  requestId: string,
): Response | null {
  if (authz.actor.type !== "ai_agent") return null;
  return fail(
    "forbidden_role",
    "Um agente de IA não cria, edita nem apaga regra automática. Quem faz isso é uma pessoa ou a integração de servidor.",
    403,
    { requestId },
  );
}

/** A falha interna chega sem o texto do banco; o texto vai para o log com o request id. */
export function falhaInterna(requestId: string, rota: string, causa: string): Response {
  return falhaDoHandlerParaToken(new ApiError(500, "internal_error", undefined, requestId, causa), requestId, rota);
}

/** Mapeia cada ação, descendo nas opções do `ai_decide` (onde um `call_webhook` também mora). */
function mapearAcoes<T extends Acao>(acoes: T[], f: (a: T) => T): T[] {
  return acoes.map((acao) => {
    const feita = f(acao);
    const opcoes = feita.config?.opcoes;
    if (feita.type === "ai_decide" && Array.isArray(opcoes)) {
      return {
        ...feita,
        config: {
          ...feita.config,
          opcoes: opcoes.map((o: { acao?: T }) => (o?.acao ? { ...o, acao: mapearAcoes([o.acao], f)[0] } : o)),
        },
      };
    }
    return feita;
  });
}

/** Descarta `secret_enc` vindo do cliente: só a cifra do servidor produz ciphertext. */
export function semCifraDeFora<T extends Acao>(acoes: T[]): T[] {
  return mapearAcoes(acoes, (acao) => {
    if (!acao.config || !("secret_enc" in acao.config)) return acao;
    const { secret_enc: _fora, ...resto } = acao.config;
    return { ...acao, config: resto };
  });
}

/** A primeira URL de webhook insegura das ações, ou `null` se todas passam. */
export function urlInsegura(acoes: Acao[]): string | null {
  let achada: string | null = null;
  mapearAcoes(acoes, (acao) => {
    const url = acao.config?.url;
    if (achada === null && acao.type === "call_webhook" && typeof url === "string") {
      try {
        assertSafeOutboundUrl(url);
      } catch (err) {
        achada = err instanceof Error ? err.message : "unsafe_url";
      }
    }
    return acao;
  });
  return achada;
}

export function recusaDeUrl(acoes: Acao[], requestId: string): Response | null {
  const motivo = urlInsegura(acoes);
  if (motivo === null) return null;
  return fail(
    "validation_failed",
    "A URL do webhook não é aceita: use https e um endereço público, nunca localhost nem rede interna.",
    422,
    { requestId, details: { campo: "actions.config.url", motivo } },
  );
}

/** A regra como o token a vê: sem `secret_enc` em lugar nenhum, com `secret_configured` no lugar. */
export function regraParaToken<R extends { actions?: unknown }>(regra: R): R {
  if (!Array.isArray(regra.actions)) return regra;
  const actions = mapearAcoes(regra.actions as Acao[], (acao) => {
    if (!acao.config || !("secret_enc" in acao.config)) return acao;
    const { secret_enc, ...resto } = acao.config;
    return { ...acao, config: { ...resto, secret_configured: Boolean(secret_enc) } };
  });
  return { ...regra, actions };
}
