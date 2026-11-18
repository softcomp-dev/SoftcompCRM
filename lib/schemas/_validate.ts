import type { ZodError, ZodSchema } from "zod";
import { ApiError } from "@/lib/api/types";

function toFieldErrors(err: ZodError): Record<string, string[]> {
  return err.flatten().fieldErrors as Record<string, string[]>;
}

/**
 * O que vai em `details` e em `message` de um 422 de schema.
 *
 * `formErrors` são as regras do objeto inteiro (`.refine` na raiz, como
 * "informe contact_id ou phone_number"). Antes só os `fieldErrors` saíam, e
 * uma recusa dessas chegava como `{ fieldErrors: {} }` + "Validation failed":
 * o integrador não tinha como saber o que faltava. Quando só a regra do objeto
 * falhou, ela vira a mensagem.
 */
function recusaDoSchema(err: ZodError): { details: Record<string, unknown>; message: string } {
  const { formErrors } = err.flatten();
  const fieldErrors = toFieldErrors(err);
  const semCampo = Object.keys(fieldErrors).length === 0;
  return {
    details: { fieldErrors, ...(formErrors.length > 0 ? { formErrors } : {}) },
    message: semCampo && formErrors[0] ? formErrors[0] : "Validation failed",
  };
}

export async function validateRequest<T>(schema: ZodSchema<T>, request: Request): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "body_malformed", undefined, crypto.randomUUID(), "Body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const { details, message } = recusaDoSchema(parsed.error);
    throw new ApiError(422, "validation_error", details, crypto.randomUUID(), message);
  }
  return parsed.data;
}

export function validateBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const { details, message } = recusaDoSchema(parsed.error);
    throw new ApiError(422, "validation_error", details, crypto.randomUUID(), message);
  }
  return parsed.data;
}
