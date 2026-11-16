/**
 * GANHO PARCIAL — o negócio foi ganho com menos do que se previa.
 *
 * É uma MARCA sobre o ganho, não um quarto status (migration 9259): o negócio
 * fica `status = 'won'` e conta como venda em conversão, metas e na data da
 * última venda do contato. `value_cents` vira o valor efetivamente fechado; o
 * previsto fica em `partial_original_value_cents`.
 *
 * A regra mora aqui para a rota (`POST /leads/[id]/win`) e o diálogo da tela
 * recusarem pelo MESMO critério.
 */
import { z } from "zod";

/** Corpo `partial` do `POST /api/v1/leads/[id]/win`. */
export const GanhoParcialSchema = z
  .object({
    value_cents: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type GanhoParcialInput = z.infer<typeof GanhoParcialSchema>;

/** Os campos de `crm_leads` que a regra lê. */
export interface LeadParaParcial {
  value_cents?: number | string | null;
  is_partial_win?: boolean | null;
  partial_original_value_cents?: number | string | null;
}

function numero(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * O valor que se PREVIA. Num negócio que já é parcial, o previsto é o que foi
 * guardado na primeira vez — remarcar o parcial nunca transforma o valor
 * fechado em "previsto".
 */
export function valorPrevistoCents(lead: LeadParaParcial): number | null {
  if (lead.is_partial_win) {
    return numero(lead.partial_original_value_cents) ?? numero(lead.value_cents);
  }
  return numero(lead.value_cents);
}

/** Por que o valor fechado não serve. */
export type RecusaDoValorParcial = "sem_valor" | "nao_e_menor_que_o_previsto";

/**
 * `null` quando o valor fechado serve. Parcial é MENOS que o previsto: igual
 * seria ganho total. Sem valor previsto, qualquer valor positivo vale. Devolve
 * código, não frase: quem mostra escreve o literal de cada ramo, para a
 * tradução alcançar (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`).
 */
export function recusaDoValorParcial(
  lead: LeadParaParcial,
  valorFechadoCents: number,
): RecusaDoValorParcial | null {
  if (!Number.isInteger(valorFechadoCents) || valorFechadoCents <= 0) return "sem_valor";
  const previsto = valorPrevistoCents(lead);
  if (previsto != null && valorFechadoCents >= previsto) return "nao_e_menor_que_o_previsto";
  return null;
}

/**
 * Os campos que a escrita do parcial grava. O trigger
 * `trg_crm_lead_parcial_some_ao_reabrir` desfaz tudo se o negócio sair do ganho.
 */
export function patchDoGanhoParcial(
  lead: LeadParaParcial,
  parcial: GanhoParcialInput,
): Record<string, unknown> {
  return {
    is_partial_win: true,
    partial_reason: parcial.reason.trim(),
    partial_original_value_cents: valorPrevistoCents(lead),
    value_cents: parcial.value_cents,
  };
}

/** A razão da linha na timeline. Canônica em português; a leitura traduz. */
export function razaoDoGanhoParcialNaTimeline(motivo: string): string {
  return `Ganho parcial — ${motivo.trim()}`;
}
