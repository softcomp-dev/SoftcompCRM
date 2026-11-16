/**
 * GET /api/v1/voip/trunk/status — o que o servidor fez com o tronco SIP da
 * organização ativa (manager+): `voip_trunk_status`, escrito pelo worker de voz
 * (`workers/voice-agent/aplicar-tronco.ts`) depois de aplicar o tronco pela ARI.
 *
 * `null` quando o worker nunca conferiu este tronco — telefonia desligada no
 * servidor, ou o tronco acabou de ser salvo. A tela distingue os dois pela
 * data: estado anterior ao último salvamento é "aguardando aplicar".
 *
 * Leitura pelo cliente de SESSÃO: a RLS (`voip_trunk_status_select`) restringe
 * à organização, e o filtro explícito por `organization_id` fica por cima.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voip_trunk_settings" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("voip_trunk_status")
    .select("state, error, applied_at, checked_at")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao consultar o estado do tronco SIP.", 500, { requestId });
  return ok(data ?? null, { requestId });
}
