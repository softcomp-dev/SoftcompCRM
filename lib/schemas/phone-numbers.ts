/**
 * Zod source-of-truth para phone_numbers (números/DID de VoIP por org).
 * `trunk_endpoint` não entra aqui: é o mesmo troncal Asterisk para toda a
 * plataforma hoje (infra compartilhada, não escolha da organização) — o
 * backend grava o valor de VOIP_TRUNK_ENDPOINT, a tela nem pergunta.
 */
import { z } from "zod";

export const routingModeEnum = z.enum(["ai", "human", "ai_then_human"]);
export type RoutingMode = z.infer<typeof routingModeEnum>;

/**
 * O telefone do time para onde a ligação é encaminhada (migration 9255). Mesmo
 * formato do número: só dígitos, `+` opcional — é o que vai na URI SIP.
 */
const telefoneDoTime = z
  .string()
  .trim()
  .min(8, "Telefone muito curto.")
  .max(16, "Telefone muito longo.")
  .regex(/^\+?[0-9]+$/, "Use só dígitos, com + opcional no início (E.164).");

/** Quanto o telefone do time toca antes de a ligação virar perdida. */
const toqueDoTime = z.coerce.number().int().min(10).max(60);

export const MENSAGEM_SEM_DESTINO_HUMANO =
  "Informe o telefone do time para onde encaminhar a ligação neste modo de atendimento.";

/**
 * Modo que passa a ligação ao time sem telefone para onde encaminhar não tem
 * como se cumprir: a ligação cairia. Recusado na escrita, para a tela não
 * prometer um atendimento que não acontece.
 */
export function faltaDestinoHumano(routingMode: RoutingMode, forwardToPhone: string | null | undefined): boolean {
  return routingMode !== "ai" && !(forwardToPhone ?? "").trim();
}

export const createPhoneNumberSchema = z
  .object({
    number: z
      .string()
      .trim()
      .min(8, "Número muito curto.")
      .max(20, "Número muito longo.")
      .regex(/^\+?[0-9]+$/, "Use só dígitos, com + opcional no início (E.164)."),
    label: z.string().trim().max(120).nullable().optional(),
    routing_mode: routingModeEnum.default("ai"),
    default_ai_agent_id: z.string().uuid().nullable().optional(),
    forward_to_phone: telefoneDoTime.nullable().optional(),
    forward_ring_seconds: toqueDoTime.optional(),
    is_active: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (faltaDestinoHumano(v.routing_mode, v.forward_to_phone)) {
      ctx.addIssue({ code: "custom", path: ["forward_to_phone"], message: MENSAGEM_SEM_DESTINO_HUMANO });
    }
  });
export type CreatePhoneNumberInput = z.infer<typeof createPhoneNumberSchema>;

export const updatePhoneNumberSchema = z
  .object({
    label: z.string().trim().max(120).nullable().optional(),
    routing_mode: routingModeEnum.optional(),
    default_ai_agent_id: z.string().uuid().nullable().optional(),
    forward_to_phone: telefoneDoTime.nullable().optional(),
    forward_ring_seconds: toqueDoTime.optional(),
    is_active: z.boolean().optional(),
  })
  .strict();
export type UpdatePhoneNumberInput = z.infer<typeof updatePhoneNumberSchema>;
