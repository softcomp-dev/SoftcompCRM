/**
 * GET /api/v1/sdr/vendedores — para quem ESTE membro pode passar um negócio.
 *
 * agent+. Responde também a quem não é SDR (e com a função desligada): aí
 * `pode_passar` é false, `motivo` diz por quê e a lista vem vazia — é assim
 * que a tela decide se mostra o "Passar para vendedor" sem tomar 403.
 *
 * Só ids: o nome de cada um a tela já tem (`/api/v1/team/assignable`), e a
 * lista de quem é SDR não sai daqui — ela é do gerente (`/sdr/assignments`).
 * A regra de quem entra é `vendedoresParaOSdr` (`lib/sdr/passagem.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { listarEquipeDaPassagem } from "@/lib/sdr/atribuicao";
import { recusaDoSdr, vendedoresParaOSdr } from "@/lib/sdr/passagem";
import { createAdminClient } from "@/lib/supabase/admin";

import { interruptorDaOrganizacao } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const eu = authz.user.id;

  const db = createAdminClient();
  const funcao = await interruptorDaOrganizacao(db, orgId, authz.user.idioma, requestId, { exigirLigada: false });
  if (!funcao.ok) return funcao.response;

  const equipe = await listarEquipeDaPassagem(db, orgId);
  if (!equipe.ok) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });

  const motivo = recusaDoSdr(equipe.membros.find((m) => m.user_id === eu) ?? null, funcao.enabled);
  if (motivo !== null) {
    return ok({ pode_passar: false, motivo, vendedores: [] as string[] }, { requestId });
  }
  return ok(
    { pode_passar: true, motivo: null, vendedores: vendedoresParaOSdr(equipe.membros, eu, funcao.enabled) },
    { requestId },
  );
}
