/**
 * TARIFA DA VOZ AO VIVO (OpenAI Realtime) — o preço que faltava para a ligação
 * entrar no gasto de IA.
 *
 * Token de ÁUDIO tem tarifa própria, muito acima da de texto, e o catálogo
 * comum (`ai_pricing`, `pricing.ts`) só conhece texto: precificar o áudio como
 * texto daria um número errado com cara de medido. Por isso a voz saía com
 * `cost_cents` nulo (`workers/voice-agent/uso-da-sessao.ts`).
 *
 * Fonte: tabela oficial https://developers.openai.com/api/docs/pricing,
 * conferida em 16/11/2026, em dólares por 1 milhão de tokens. Aqui em CENTAVOS
 * de dólar (×100), a mesma unidade de `llm_calls.cost_cents`.
 *
 * Modelo fora desta tabela (ex.: `gpt-4o-realtime-preview`, que a página não
 * lista mais) devolve `null`: o gasto segue marcado como incompleto na tela, em
 * vez de um número inventado. Preço mudou? Atualize esta tabela e a data acima.
 */
export interface TarifaDeVoz {
  textoEntrada: number;
  textoCache: number;
  textoSaida: number;
  audioEntrada: number;
  audioCache: number;
  audioSaida: number;
}

/** Centavos de dólar por 1 milhão de tokens. */
export const TARIFAS_DE_VOZ: Readonly<Record<string, TarifaDeVoz>> = {
  "gpt-realtime": { textoEntrada: 400, textoCache: 40, textoSaida: 1600, audioEntrada: 3200, audioCache: 40, audioSaida: 6400 },
  "gpt-realtime-mini": { textoEntrada: 60, textoCache: 6, textoSaida: 240, audioEntrada: 1000, audioCache: 30, audioSaida: 2000 },
  "gpt-realtime-2.1": { textoEntrada: 400, textoCache: 40, textoSaida: 2400, audioEntrada: 3200, audioCache: 40, audioSaida: 6400 },
  "gpt-realtime-2.1-mini": { textoEntrada: 60, textoCache: 6, textoSaida: 240, audioEntrada: 1000, audioCache: 30, audioSaida: 2000 },
};

export interface UsoDeVozParaPreco {
  entradaTexto: number;
  entradaAudio: number;
  /** Tokens de entrada servidos do cache, por tipo. */
  cacheTexto: number;
  cacheAudio: number;
  saidaTexto: number;
  saidaAudio: number;
}

/**
 * O custo da sessão em centavos (fracionado), ou `null` sem tarifa conhecida.
 * O cache é PARTE da entrada (a OpenAI conta `cached_tokens` dentro de
 * `input_tokens`), então sai do preço cheio e entra no do cache.
 */
export function custoDaVozEmCentavos(modelo: string, uso: UsoDeVozParaPreco): number | null {
  const t = TARIFAS_DE_VOZ[modelo];
  if (!t) return null;
  const cacheTexto = Math.min(uso.cacheTexto, uso.entradaTexto);
  const cacheAudio = Math.min(uso.cacheAudio, uso.entradaAudio);
  const total =
    (uso.entradaTexto - cacheTexto) * t.textoEntrada +
    cacheTexto * t.textoCache +
    (uso.entradaAudio - cacheAudio) * t.audioEntrada +
    cacheAudio * t.audioCache +
    uso.saidaTexto * t.textoSaida +
    uso.saidaAudio * t.audioSaida;
  return total / 1_000_000;
}
