/**
 * /api/v1/settings/sdr — o interruptor da função SDR desta empresa
 * (`organizations.settings.sdr.enabled`, esquema em `lib/sdr/configuracao.ts`).
 *
 * GET   qualquer membro (viewer+): `{ enabled }`. Telas e integrações perguntam
 *       aqui antes de oferecer qualquer coisa de SDR.
 * PATCH admin: `{ enabled: boolean }`. Desligar NÃO desmarca ninguém: as
 *       marcas ficam e só perdem efeito (`lib/sdr/permissoes.ts`); religar
 *       devolve a equipe como estava.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { comConfiguracaoSdr, configuracaoSdrSchema, lerConfiguracaoSdr } from "@/lib/sdr/configuracao";
import { createAdminClient } from "@/lib/supabase/admin";

import { interruptorDaOrganizacao } from "../../sdr/_shared";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "organizations" });
  if (!authz.ok) return authz.response;

  const lido = await interruptorDaOrganizacao(createAdminClient(), authz.org.orgId, authz.user.idioma, requestId, {
    exigirLigada: false,
  });
  if (!lido.ok) return lido.response;
  return ok({ enabled: lido.enabled }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "organizations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = configuracaoSdrSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  // Admin client: a RLS de `organizations` só deixa platform admin escrever
  // (mesmo motivo de `settings/catalogo`, issue #144).
  const db = createAdminClient();
  const lido = await db.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  // Leitura que falhou não vira `settings` vazio: o update apagaria o resto da configuração.
  if (lido.error || !lido.data) return fail("internal_error", t("Falha ao salvar."), 500, { requestId });

  const settings = lido.data.settings as Record<string, unknown> | null;
  const antes = lerConfiguracaoSdr(settings).enabled;
  // Sem mudança: responde o estado e não escreve nem audita (não é mutação).
  if (antes === parsed.data.enabled) return ok(parsed.data, { requestId });

  // CAS do documento inteiro: escrita concorrente de outra tela nunca perde
  // outra chave de `settings`; quem perde a corrida recebe 409 e recarrega.
  const update = db.from("organizations").update({ settings: comConfiguracaoSdr(settings, parsed.data) }).eq("id", orgId);
  const salvo = await (settings === null
    ? update.is("settings", null)
    : update.filter("settings", "eq", JSON.stringify(settings))
  )
    .select("id")
    .maybeSingle();
  if (salvo.error) return fail("internal_error", t("Falha ao salvar."), 500, { requestId });
  if (!salvo.data) {
    return fail("conflict", t("A configuração mudou. Recarregue a página e tente novamente."), 409, { requestId });
  }

  void audit({
    action: "sdr.settings_changed",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { enabled: parsed.data.enabled },
  });

  return ok(parsed.data, { requestId });
}
