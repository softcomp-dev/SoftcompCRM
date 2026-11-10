/**
 * O ATO de tirar uma pessoa de uma organização — o mesmo efeito para os dois
 * chamadores:
 *
 * - `app/api/v1/team/[user_id]/revoke` — o admin da organização, na tela de
 *   Equipe (client por cookie, sob RLS);
 * - `app/api/v1/admin/users/[id]/vinculos` — o dono da instalação, na tela de
 *   Vínculos do /admin (client de serviço, sem RLS, organização vinda do path).
 *
 * Enquanto o efeito morava só na rota da Equipe, revogar pela tela de vínculos
 * teria de reescrever as quatro consequências — e a que fosse esquecida (a
 * conversa que fica atribuída a quem saiu, a inscrição de push que continua
 * tocando) só apareceria em produção.
 *
 * Guardas que valem para os dois: não revoga o último admin; revogar quem já
 * saiu é sucesso idempotente. "Não revogar a si mesmo" é do chamador — na
 * Equipe é regra, no /admin o dono pode sair de uma empresa que não opera.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import type { Role } from "@/lib/auth/types";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export interface EntradaDaRevogacao {
  organizationId: string;
  targetUserId: string;
  /** Quem revoga, e com que papel aparece na linha do tempo da conversa. */
  actor: { id: string; role: Role };
  requestId: string;
  /** O dono da instalação revoga sem ser membro: o audit diz isso. */
  comoPlatformAdmin?: boolean;
}

export type ResultadoDaRevogacao =
  | { ok: true; revokedAt: string; jaRevogado: boolean }
  | { ok: false; motivo: "nao_encontrado"; detalhe?: undefined }
  | { ok: false; motivo: "ultimo_admin"; detalhe?: undefined }
  | { ok: false; motivo: "erro"; detalhe: string };

// O client chega pronto de quem chama: sob RLS na Equipe, de serviço no /admin.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>;

export async function revogarVinculo(
  supabase: SB,
  entrada: EntradaDaRevogacao,
): Promise<ResultadoDaRevogacao> {
  const { organizationId, targetUserId, actor, requestId, comoPlatformAdmin } = entrada;
  const extraDeAudit = comoPlatformAdmin
    ? { actingAsPlatformAdmin: true, bypassedRls: true }
    : {};

  const { data: target, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", organizationId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return { ok: false, motivo: "erro", detalhe: fetchErr.message };
  if (!target) return { ok: false, motivo: "nao_encontrado" };
  if (target.revoked_at) {
    return { ok: true, revokedAt: target.revoked_at as string, jaRevogado: true };
  }

  if (target.role === "admin") {
    const { count, error: countErr } = await supabase
      .from("user_organizations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("role", "admin")
      .is("revoked_at", null);
    if (countErr) return { ok: false, motivo: "erro", detalhe: countErr.message };
    if ((count ?? 0) <= 1) return { ok: false, motivo: "ultimo_admin" };
  }

  // Conversas abertas atribuídas a quem está saindo — o trigger do banco desatribui
  // para a fila e aqui se grava a linha do tempo e o audit de liberação de cada uma (#1562).
  const { data: openConvs } = await supabase
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", organizationId)
    .eq("assigned_to_user_id", targetUserId)
    .in("status", ["open", "pending", "claimed", "ai_handling"]);

  // #3696: derrubar o snapshot ANTES da escrita fecha a janela em que uma tela
  // que atualiza "ao vivo" pede o valor velho no meio do UPDATE e o guarda de
  // novo. A invalidação de baixo, depois do commit, cobre o intervalo que sobra.
  invalidarUsuario(targetUserId);

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("user_organizations")
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq("id", target.id);
  if (updErr) return { ok: false, motivo: "erro", detalhe: updErr.message };

  // #3696: acesso REVOGADO não pode sobreviver ao cache curto.
  invalidarUsuario(targetUserId);

  // A inscrição é do membro, e a RLS de `push_subscriptions` só deixa cada um
  // tocar a própria: a remoção vai pelo service role, presa à organização.
  // Falhar aqui não desfaz a revogação — o envio já exige vínculo ativo.
  const { count: pushRemovidos, error: pushErr } = await createAdminClient()
    .from("push_subscriptions")
    .delete({ count: "exact" })
    .eq("organization_id", organizationId)
    .eq("user_id", targetUserId);
  if (pushErr) {
    logger.warn("member_revoke_push_cleanup_failed", { detail: pushErr.message });
  }

  if (openConvs && openConvs.length > 0) {
    for (const conv of openConvs) {
      await audit({
        action: "conversation.released",
        actorUserId: actor.id,
        organizationId,
        resourceType: "conversation",
        resourceId: conv.id,
        requestId,
        metadata: { reason: "member_revoked", target_user_id: targetUserId },
        ...extraDeAudit,
      });

      await registrarTrocaDeComando({
        supabase,
        organizationId,
        conversationId: conv.id,
        contactId: conv.contact_id,
        tipo: "conversation_released",
        actor: { type: "user", id: actor.id, role: actor.role },
        motivo: "Atendente revogado da organização",
      });
    }
  }

  await audit({
    action: "member.revoked",
    actorUserId: actor.id,
    organizationId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      revoked_role: target.role,
      released_conversations_count: openConvs?.length ?? 0,
      removed_push_subscriptions_count: pushErr ? null : (pushRemovidos ?? 0),
    },
    ...extraDeAudit,
  });

  return { ok: true, revokedAt: nowIso, jaRevogado: false };
}
