/**
 * A PORTA das rotas da visão consolidada (`/api/v1/consolidado/*`): quem é a
 * pessoa e quais empresas ela pode ver agora.
 *
 * Três recusas antes de qualquer leitura:
 * - sem sessão → 401;
 * - em acompanhamento de suporte → 403: o suporte é preso a UMA empresa, e a
 *   visão cruza empresas por definição;
 * - MFA em dívida → 403 `mfa_required`, como toda rota do app.
 *
 * Os vínculos são lidos FRESCOS (não do snapshot da sessão), com as mesmas
 * condições do seletor de empresa (`app/actions/shell/setActiveOrg.ts`): aceito,
 * não revogado, empresa ativa. O platform admin NÃO ganha todas as empresas
 * aqui — a visão é de quem opera; o dono da instalação vê as empresas em que
 * tem vínculo, e as outras pelo /admin.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida } from "@/lib/auth/server";
import type { AuthUser, Role } from "@/lib/auth/types";
import { MENSAGEM_DE_MFA } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { empresasDoEscopo, lerEmpresasDaUrl, type EmpresaDoEscopo } from "./escopo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;

export type PortaDaVisao =
  | {
      ok: true;
      user: AuthUser;
      supabase: SB;
      /** Todas as empresas da pessoa (o seletor da tela mostra estas). */
      vinculos: EmpresaDoEscopo[];
      /** As que a consulta desta chamada cobre (as filtradas, ou todas). */
      escopo: EmpresaDoEscopo[];
      t: (texto: string) => string;
    }
  | { ok: false; response: Response };

export async function abrirVisaoConsolidada(
  requestId: string,
  empresasDaUrl: string | null,
): Promise<PortaDaVisao> {
  const user = await loadAuthUser();
  if (!user) {
    return { ok: false, response: fail("unauthenticated", "Auth required.", 401, { requestId }) };
  }
  const t = (texto: string) => traduzir(texto, user.idioma);
  if (user.support) {
    return {
      ok: false,
      response: fail(
        "forbidden",
        t("Encerre o acompanhamento antes de abrir a visão consolidada."),
        403,
        { requestId },
      ),
    };
  }
  if (await mfaEmDivida()) {
    return { ok: false, response: fail("mfa_required", t(MENSAGEM_DE_MFA), 403, { requestId }) };
  }

  const supabase = (await createClient()) as SB;
  const { data, error } = await supabase
    .from("user_organizations")
    .select(
      "organization_id, role, accepted_at, organizations!user_organizations_organization_id_fkey!inner(display_name, status)",
    )
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .eq("organizations.status", "active")
    .order("accepted_at", { ascending: true })
    .order("organization_id", { ascending: true });
  if (error) {
    return { ok: false, response: fail("internal_error", error.message, 500, { requestId }) };
  }

  type Linha = {
    organization_id: string;
    role: Role;
    organizations: { display_name: string } | { display_name: string }[] | null;
  };
  const vinculos: EmpresaDoEscopo[] = ((data ?? []) as unknown as Linha[]).map((l) => {
    const org = Array.isArray(l.organizations) ? l.organizations[0] : l.organizations;
    return { organization_id: l.organization_id, nome: org?.display_name ?? "—", role: l.role };
  });

  return {
    ok: true,
    user,
    supabase,
    vinculos,
    escopo: empresasDoEscopo(vinculos, lerEmpresasDaUrl(empresasDaUrl)),
    t,
  };
}
