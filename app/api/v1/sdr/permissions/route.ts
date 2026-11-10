/**
 * GET /api/v1/sdr/permissions[?user_id=<uuid>] — as permissões de SDR de um
 * membro, calculadas a partir da configuração da organização + vínculo
 * (`lib/sdr/permissoes.ts`, a única regra).
 *
 * Sem `user_id` (ou com o próprio): qualquer membro, viewer inclusive — é
 * assim que a tela sabe o que mostrar a quem está logado. De outra pessoa:
 * manager+, a mesma régua de leitura da equipe.
 *
 * Responde também com a função DESLIGADA: aí `sdr.feature_enabled` é false e
 * `inactive_reason` diz por quê. Recusar com 409 esconderia do admin a única
 * permissão que ele tem nesse estado — `sdr.settings.manage`, a de ligá-la.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerMembro } from "@/lib/sdr/atribuicao";
import { permissoesDoMembro } from "@/lib/sdr/permissoes";
import { createAdminClient } from "@/lib/supabase/admin";

import { interruptorDaOrganizacao } from "../_shared";

export const dynamic = "force-dynamic";

const querySchema = z.object({ user_id: z.string().uuid().optional() }).strict();

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const query = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  const alvo = query.data.user_id ?? authz.user.id;

  if (alvo !== authz.user.id) {
    const deOutro = await requireRole("manager", { requestId, resource: "team" });
    if (!deOutro.ok) return deOutro.response;
  }

  const db = createAdminClient();
  const funcao = await interruptorDaOrganizacao(db, orgId, authz.user.idioma, requestId, { exigirLigada: false });
  if (!funcao.ok) return funcao.response;

  const lido = await lerMembro(db, orgId, alvo);
  if (!lido.ok) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });
  if (!lido.membro) return fail("not_found", t("Membro não encontrado."), 404, { requestId });

  return ok(permissoesDoMembro(lido.membro, funcao.enabled), { requestId });
}
