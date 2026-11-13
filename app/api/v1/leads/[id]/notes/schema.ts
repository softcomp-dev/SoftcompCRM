import { z } from "zod";

import type { ActivityType } from "@/lib/leads/activity-vocabulary";

/**
 * O tipo da atividade que uma nota grava. Constante, nunca literal no emissor
 * (`crm_lead_activities.type` é vocabulário aberto e só o TypeScript o vigia):
 * `satisfies` amarra ao `ActivityType`, então renomear o tipo lá quebra aqui.
 */
export const TIPO_DA_NOTA = "note" as const satisfies ActivityType;

/** Quanto no futuro uma nota pode estar datada (relógio do ERP adiantado). */
const TOLERANCIA_DE_RELOGIO_MS = 5 * 60 * 1000;

export const notaDoNegocioSchema = z
  .object({
    body: z.string().trim().min(1).max(5000),
    /** Quando o fato aconteceu, se não for agora (ex.: boleto vencido ontem). */
    occurred_at: z
      .string()
      .datetime({ offset: true })
      .refine((v) => Date.parse(v) <= Date.now() + TOLERANCIA_DE_RELOGIO_MS, {
        message: "occurred_at não pode estar no futuro.",
      })
      .optional(),
  })
  .strict();

export type NotaDoNegocioInput = z.infer<typeof notaDoNegocioSchema>;
