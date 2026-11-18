// lib/propostas/efeitos-da-decisao.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { cancelaRetornoNoCrm } from "@/lib/followup/retorno-crm";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";

export interface PropostaDecidida {
  id: string;
  lead_id: string | null;
  contact_id: string | null;
  retorno_id: string | null;
}

export interface EfeitosDaDecisaoInput {
  db: SupabaseClient;
  organizationId: string;
  userId: string;
  requestId: string;
  proposta: PropostaDecidida;
  decisao: "aceita" | "recusada";
  motivo?: string | null;
}

/**
 * O que acontece DEPOIS que a proposta foi gravada como aceita ou recusada:
 * a atividade no negócio, o cancelamento do retorno automático e a auditoria.
 *
 * Um lugar só porque a proposta se decide por dois caminhos — a decisão
 * inteira (`/decide`) e o último item decidido (`/itens`) — e os dois têm de
 * deixar o mesmo rastro.
 */
export async function aplicarEfeitosDaDecisao(input: EfeitosDaDecisaoInput): Promise<void> {
  const { db, organizationId, userId, requestId, proposta, decisao, motivo } = input;

  // value_cents do lead NÃO muda aqui (spec §16.2 — negócio perdido guarda
  // quanto valia; zerar apagaria o histórico de quanto se deixou na mesa).
  // D10: proposta órfã (negócio apagado, `lead_id` nulo) decide normalmente —
  // só não há negócio para registrar atividade nele.
  if (proposta.lead_id) {
    await emitLeadActivity(db, {
      organizationId,
      leadId: proposta.lead_id,
      contactId: proposta.contact_id,
      type: decisao === "aceita" ? "proposal_accepted" : "proposal_declined",
      sourceModule: "proposals",
      sourceId: proposta.id,
      actor: { type: "user", id: userId },
      reason: decisao === "aceita" ? "Proposta aceita pelo cliente" : `Proposta recusada${motivo ? `: ${motivo}` : ""}`,
    });
  }

  // N2 — a decisão resolve a proposta: o retorno automático agendado no envio
  // não é mais necessário. Best-effort de verdade (achado Importante da
  // revisão final da C3b+E1): a decisão JÁ foi gravada — um erro de banco aqui
  // (instabilidade ao cancelar) não pode virar 500 nem comer a auditoria
  // abaixo, senão a tela mostra erro para uma decisão que já vale, e um retry
  // recebe 409 (status já não é mais 'enviada').
  if (proposta.retorno_id) {
    try {
      await cancelaRetornoNoCrm(
        { admin: db, orgId: organizationId, actor: { type: "user", id: userId } },
        proposta.retorno_id,
        { motivo: `Proposta ${decisao} — retorno automático não é mais necessário` },
      );
    } catch (erro) {
      logger.warn("proposal.decide: cancelamento do retorno automático falhou sem bloquear a decisão", {
        propostaId: proposta.id,
        organizationId,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  void audit({
    action: decisao === "aceita" ? "proposal.aceita" : "proposal.recusada",
    actorUserId: userId,
    organizationId,
    resourceType: "crm_proposals",
    resourceId: proposta.id,
    requestId,
  });
}
