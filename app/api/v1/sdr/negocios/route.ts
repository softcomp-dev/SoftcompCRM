/**
 * GET /api/v1/sdr/negocios — os negócios que o SDR logado pode passar ao
 * vendedor: abertos, com ele ou sem dono humano (fila ou agente de IA). É a
 * lista da tela "Leads sem vendedor" (`/app/sdr`, docs/features/sdr.md).
 *
 * agent+ e SDR ativo. Recusas: 409 `sdr_disabled` (função desligada) e 403
 * `sdr_handoff_forbidden` (quem chamou não é SDR ativo) — as mesmas da passagem
 * (`POST /api/v1/leads/[id]/passar-ao-vendedor`), para a tela e a ação nunca
 * discordarem.
 *
 * A régua de quem é SDR lê `user_organizations` pelo client admin (a RLS só
 * mostra ao agent o próprio vínculo), filtrado pela organização do cookie. Os
 * negócios vêm pelo client de SESSÃO: a RLS decide o que o SDR enxerga.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { listarEquipeDaPassagem } from "@/lib/sdr/atribuicao";
import { carregarNegociosDoSdr } from "@/lib/sdr/negocios-do-sdr";
import { recusaDoSdr } from "@/lib/sdr/passagem";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { interruptorDaOrganizacao } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const idioma = authz.user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const orgId = authz.org.orgId; // do cookie validado, nunca do corpo
  const eu = authz.user.id;

  const admin = createAdminClient();
  const funcao = await interruptorDaOrganizacao(admin, orgId, idioma, requestId, { exigirLigada: true });
  if (!funcao.ok) return funcao.response;

  const equipe = await listarEquipeDaPassagem(admin, orgId);
  if (!equipe.ok) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });

  const motivo = recusaDoSdr(equipe.membros.find((m) => m.user_id === eu) ?? null, true);
  if (motivo !== null) {
    return fail("sdr_handoff_forbidden", t("Só um SDR ativo vê os leads sem vendedor."), 403, {
      requestId,
      details: { motivo },
    });
  }

  const lido = await carregarNegociosDoSdr(await createClient(), { organizationId: orgId, sdrId: eu, t });
  if (!lido.ok) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });

  return ok(lido.negocios, {
    requestId,
    meta: { total: lido.negocios.length, has_more: lido.truncado },
  });
}
