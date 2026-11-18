import { z } from "zod";
import { STATUS_DO_ITEM_DA_PROPOSTA } from "@/lib/propostas/tipos";

/**
 * O CONTRATO DA PROPOSTA — um só, lido pela tela E pela rota (padrão
 * `lib/schemas/produtos.ts`, CLAUDE.md).
 */

export const propostaItemSchema = z.object({
  id: z.string().uuid().optional(),
  product_id: z.string().uuid().nullable(),
  descricao: z.string().trim().min(1).max(500),
  quantidade: z.number().positive(),
  preco_unitario_cents: z.number().int().nonnegative().nullable(),
  desconto_cents: z.number().int().nonnegative().default(0),
  position: z.number(),
});

export const propostaCreateSchema = z.object({
  lead_id: z.string().uuid(),
  titulo: z.string().trim().min(1).max(200),
  condicoes: z.string().max(4000).nullable().optional(),
  valid_until: z.string().date().nullable().optional(),
  itens: z.array(propostaItemSchema).default([]),
});
export type PropostaCreateInput = z.infer<typeof propostaCreateSchema>;

/**
 * 9261 — corpo de `PATCH /api/v1/proposals/{id}/itens` (tela e token): o
 * status novo de um ou mais itens. A fase de cada um é regra do servidor
 * (`lib/propostas/status-do-item.ts`).
 */
export const statusDosItensSchema = z.object({
  itens: z
    .array(z.object({ id: z.string().uuid(), status: z.enum(STATUS_DO_ITEM_DA_PROPOSTA) }))
    .min(1)
    .max(200),
});
