"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { DIAS_MAXIMO, DIAS_MINIMO } from "@/lib/clientes/classificacao";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A mesma faixa da CHECK `organizations_classificacao_dias_check` (migration
 * 9257). A duplicação é declarada: sem ela, um valor fora da faixa só voltaria
 * como erro cru do Postgres em vez de `validation_failed`.
 */
const classificacaoSchema = z
  .object({
    ativoDias: z.number().int().min(DIAS_MINIMO).max(DIAS_MAXIMO),
    preInativoDias: z.number().int().min(DIAS_MINIMO).max(DIAS_MAXIMO),
  })
  .strict()
  .refine((v) => v.preInativoDias > v.ativoDias, { path: ["preInativoDias"] });

export type PrazosDeClassificacao = z.infer<typeof classificacaoSchema>;
export type PrazosDeClassificacaoResult = { ok: true } | { ok: false; error: string };

/**
 * Grava os prazos da classificação de clientes da ORGANIZAÇÃO — o que a lista,
 * a ficha, o filtro, o público de campanha e o aviso de pré-inativo leem.
 *
 * Gates iguais aos de `atualizarLembreteDeCasoParado`: sessão de suporte não
 * escreve, papel `admin` (ou super-admin fora de suporte), dívida de MFA. A
 * escrita vai pelo admin client porque a única policy de escrita de
 * `organizations` é a de plataforma (issue #144), e a organização vem da
 * SESSÃO, nunca do corpo.
 */
export async function atualizarClassificacaoDeClientes(
  input: PrazosDeClassificacao,
): Promise<PrazosDeClassificacaoResult> {
  const parsed = classificacaoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const novo = {
    classificacao_ativo_dias: parsed.data.ativoDias,
    classificacao_pre_inativo_dias: parsed.data.preInativoDias,
  };

  const { error } = await createAdminClient().from("organizations").update(novo).eq("id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error" };

  const hdrs = await headers();
  await audit({
    action: "crm.classificacao_de_clientes_configurada",
    organizationId: activeOrg.orgId,
    actorUserId: authUser.id,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
    metadata: novo,
  });

  revalidatePath("/app/settings/tenant");
  revalidatePath("/app/contacts");
  return { ok: true };
}
