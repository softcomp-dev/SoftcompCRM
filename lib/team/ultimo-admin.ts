/**
 * O último administrador de uma empresa — a régua única das três portas que
 * rebaixam ou revogam (troca de papel da Equipe, revogação de membro, Vínculos
 * do painel do dono).
 *
 * Quem conta como admin: papel admin, vínculo não revogado e convite ACEITO.
 * Um convite de admin pendente não administra nada; contá-lo permitia tirar o
 * último admin de verdade enquanto o convite esperava.
 *
 * A contagem aqui é a resposta RÁPIDA e legível (409 antes de escrever). Quem
 * garante de verdade é o gatilho `trg_guarda_ultimo_admin` (migration 9253),
 * que conta dentro da transação da escrita, sob trava por organização: duas
 * remoções simultâneas não passam as duas. `ehRecusaDeUltimoAdmin` reconhece a
 * recusa dele para a rota responder o mesmo 409.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;

/** O vínculo como a régua precisa ler. */
export interface VinculoDoAdmin {
  role: string;
  revoked_at: string | null;
  accepted_at: string | null;
}

/** Este vínculo administra a empresa agora? */
export function administraAgora(v: VinculoDoAdmin): boolean {
  return v.role === "admin" && v.revoked_at === null && v.accepted_at !== null;
}

/** Quantos admins ativos e aceitos a empresa tem (o próprio alvo incluído). */
export async function contarAdminsAtivos(
  supabase: SB,
  organizationId: string,
): Promise<{ count: number; error: { message: string } | null }> {
  const { count, error } = await supabase
    .from("user_organizations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null)
    .not("accepted_at", "is", null);
  return { count: count ?? 0, error };
}

/** O erro é a recusa do gatilho do banco (`PT409 ultimo_admin`)? */
export function ehRecusaDeUltimoAdmin(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "PT409" && (error.message ?? "").includes("ultimo_admin");
}
