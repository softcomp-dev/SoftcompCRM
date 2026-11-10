/**
 * Interruptor da função SDR por organização — `organizations.settings.sdr`.
 *
 * Esquema central desta chave do jsonb (anti-pattern 6: ninguém lê o path
 * direto). Padrão DESLIGADO: uma organização que nunca tocou na chave não tem
 * SDR, e nada no produto muda para ela.
 *
 * A leitura nunca lança: `settings` é jsonb escrito por várias telas, e um
 * valor torto aqui não pode virar 500 numa rota que só quer saber se a função
 * está ligada — vira "desligada", que é o lado seguro.
 */
import { z } from "zod";

export const configuracaoSdrSchema = z.object({ enabled: z.boolean() }).strict();
export type ConfiguracaoSdr = z.infer<typeof configuracaoSdrSchema>;

export const CONFIGURACAO_SDR_PADRAO: ConfiguracaoSdr = { enabled: false };

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Lê `settings.sdr` de um documento de `organizations.settings`. Nunca lança. */
export function lerConfiguracaoSdr(settings: unknown): ConfiguracaoSdr {
  if (!ehObjeto(settings) || !ehObjeto(settings.sdr)) return CONFIGURACAO_SDR_PADRAO;
  return { enabled: settings.sdr.enabled === true };
}

/**
 * Devolve o documento `settings` inteiro com `sdr` atualizado, sem encostar em
 * nenhuma outra chave — inclusive em chaves de `settings.sdr` que uma versão
 * futura acrescente.
 */
export function comConfiguracaoSdr(
  settings: Record<string, unknown> | null,
  nova: ConfiguracaoSdr,
): Record<string, unknown> {
  const atual = settings ?? {};
  const sdr = ehObjeto(atual.sdr) ? atual.sdr : {};
  return { ...atual, sdr: { ...sdr, enabled: nova.enabled } };
}
