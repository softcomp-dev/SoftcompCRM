/**
 * Peças comuns das rotas `/api/v1/sdr/*` (docs/features/sdr.md).
 *
 * Organização sempre do `requireRole` (cookie validado), nunca do corpo; o
 * client é o admin porque a RLS de `user_organizations` só mostra o próprio
 * vínculo a quem não é admin, e toda consulta de `lib/sdr/atribuicao.ts`
 * filtra `organization_id` à mão.
 */
import { fail } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { lerFuncaoSdrLigada } from "@/lib/sdr/atribuicao";
import type { createAdminClient } from "@/lib/supabase/admin";

export type DbSdr = ReturnType<typeof createAdminClient>;

/**
 * Resolve o interruptor. Devolve a resposta de recusa (500 se não deu para
 * ler, 409 `sdr_disabled` se desligada e `exigirLigada`) ou o valor lido.
 */
export async function interruptorDaOrganizacao(
  db: DbSdr,
  orgId: string,
  idioma: Idioma,
  requestId: string,
  { exigirLigada }: { exigirLigada: boolean },
): Promise<{ ok: true; enabled: boolean } | { ok: false; response: Response }> {
  const t = (texto: string) => traduzir(texto, idioma);
  const lido = await lerFuncaoSdrLigada(db, orgId);
  if (!lido.ok) {
    return { ok: false, response: fail("internal_error", t("Falha ao carregar."), 500, { requestId }) };
  }
  if (exigirLigada && !lido.enabled) {
    return {
      ok: false,
      response: fail("sdr_disabled", t("A função SDR está desligada nesta empresa."), 409, { requestId }),
    };
  }
  return { ok: true, enabled: lido.enabled };
}
