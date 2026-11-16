/**
 * O FIM DE UMA LIGAÇÃO, para os dois provedores de voz.
 *
 * `voice_calls` guarda ligação de duas origens — a do WhatsApp (WaCalls,
 * `lib/wacalls/events-bridge.ts`) e a do tronco SIP (worker
 * `workers/voice-agent`) — e as duas precisam deixar o mesmo rastro quando
 * terminam. Este módulo é esse rastro, num lugar só:
 *
 *   1. **Aviso na Central** (`voice_call_missed`) para a ligação RECEBIDA que
 *      ninguém atendeu — alguém precisa ligar de volta. A ligação FEITA daqui
 *      que o cliente não atendeu não avisa: quem discou já sabe.
 *   2. **Registro em `event_log`** (`voice_call.ended`, nascido `done`: é fato,
 *      não comando — ver `tests/unit/evento-de-fato-nao-fica-pendente.test.ts`).
 *   3. **Linha do tempo do negócio**, com três tipos que não são cosméticos:
 *      `voice_call` (atendida) quebra o silêncio do negócio;
 *      `voice_call_missed` (recebida e perdida) e `voice_call_unanswered`
 *      (feita e sem resposta) não quebram — ninguém falou com ninguém.
 *
 * Contato bloqueado: a ligação ATENDIDA aconteceu e fica no histórico; a
 * perdida de bloqueado não abre aviso nem carimba a linha do tempo (ligar de
 * volta para ele já é recusado com 403).
 *
 * Quem chama já gravou o `ended` na linha; aqui só se registra o que decorre.
 * Nada aqui faz HTTP e nada aqui decide o desfecho — ele chega pronto.
 */
import type pg from "pg";

import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";

import type { Logger } from "@/lib/agent-engine/obs/logger";

export interface LigacaoEncerrada {
  id: string;
  contact_id: string | null;
  answered_at: string | null;
  peer_phone: string;
  owner_user_id: string | null;
  direction: "inbound" | "outbound";
}

export interface PedidoDeRegistrarFim {
  organizationId: string;
  ligacao: LigacaoEncerrada;
  /** `end_reason` cru, como ficou na linha. */
  endReason: string;
  /** O motivo em linguagem de gente — vai no corpo do aviso e na linha do tempo. */
  motivoLegivel: string;
  /** Agente de IA que atendeu, quando foi a IA. A pessoa (`owner_user_id`) precede. */
  agentId?: string | null;
  /** Rótulo da atendida na linha do tempo. */
  rotuloDaAtendida?: string;
  /** Campos a mais no payload do `voice_call.ended` (ex.: o id do provedor). */
  payloadDoEvento?: Record<string, unknown>;
  /**
   * A ligação foi passada ao time (pela IA ou direto) e ninguém atendeu. Ela
   * pode ter sido atendida pela IA antes — mas quem ligou pediu uma pessoa e
   * não falou com nenhuma, então alguém precisa ligar de volta.
   */
  timeNaoAtendeu?: boolean;
}

/** Para teste: o desfecho que cada ligação produz, sem tocar banco. */
export function desfechoDaLigacao(
  ligacao: Pick<LigacaoEncerrada, "answered_at" | "direction">,
  bloqueado: boolean,
  opcoes: { timeNaoAtendeu?: boolean } = {},
): {
  atendida: boolean;
  recebida: boolean;
  abreAviso: boolean;
  carimbaLinhaDoTempo: boolean;
  tipoNaLinhaDoTempo: "voice_call" | "voice_call_missed" | "voice_call_unanswered";
} {
  const atendida = !!ligacao.answered_at;
  const recebida = ligacao.direction === "inbound";
  return {
    atendida,
    recebida,
    // SABOTAGEM: remover o `&& !bloqueado` = o caso de bloqueado volta a avisar.
    abreAviso: ((!atendida && recebida) || (recebida && !!opcoes.timeNaoAtendeu)) && !bloqueado,
    carimbaLinhaDoTempo: !(bloqueado && recebida && !atendida),
    tipoNaLinhaDoTempo: atendida ? "voice_call" : recebida ? "voice_call_missed" : "voice_call_unanswered",
  };
}

/**
 * Bloqueado OU pessoal (spec 21): os dois saem da operação do mesmo jeito —
 * sem aviso na Central e sem carimbo de perdida na linha do tempo. Fail-open:
 * erro de leitura devolve `false` — nunca se suprime aviso no escuro.
 */
export async function contatoEstaBloqueado(
  pool: pg.Pool,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ is_blocked: boolean | null }>(
      `select (is_blocked or is_personal) as is_blocked from contacts where organization_id = $1 and id = $2`,
      [organizationId, contactId],
    );
    return rows[0]?.is_blocked === true;
  } catch {
    return false;
  }
}

export async function registrarFimDaLigacao(
  pool: pg.Pool,
  p: PedidoDeRegistrarFim,
  log: Logger,
): Promise<void> {
  const row = p.ligacao;
  const bloqueado = row.contact_id
    ? await contatoEstaBloqueado(pool, p.organizationId, row.contact_id)
    : false;
  const d = desfechoDaLigacao(row, bloqueado, { timeNaoAtendeu: p.timeNaoAtendeu });

  if (bloqueado) {
    log.info("voz: ligação encerrada de bloqueado, sem aviso", {
      contact_id: row.contact_id,
      answered: d.atendida,
    });
  }

  // `ref_kind = 'contact'`: a ficha do contato é onde mora o botão de ligar,
  // então abrir o contexto e FAZER o que o aviso pede viram o mesmo clique
  // (`POLITICAS_DE_AVISO` em `lib/ai/inbox-destino.ts`).
  if (d.abreAviso) {
    await pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ($1, 'voice_call_missed', 'warn', $2, $3, $4, $5)`,
      [
        p.organizationId,
        `Chamada perdida de ${row.peer_phone}`,
        p.motivoLegivel,
        row.contact_id ? "contact" : null,
        row.contact_id,
      ],
    );
  }

  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, status, payload)
     values ($1, 'voice_call.ended', 'voice_call', $2, 'done', $3)`,
    [
      p.organizationId,
      row.id,
      JSON.stringify({ ...(p.payloadDoEvento ?? {}), end_reason: p.endReason, answered: d.atendida }),
    ],
  );

  if (row.contact_id && d.carimbaLinhaDoTempo) {
    const result = await emitAgentActivityForContact({
      pool,
      organizationId: p.organizationId,
      contactId: row.contact_id,
      type: d.tipoNaLinhaDoTempo,
      reason: d.atendida
        ? (p.rotuloDaAtendida ?? "Chamada de voz atendida")
        : d.recebida
          ? `Chamada de voz perdida — ${p.motivoLegivel}`
          : `Chamada de voz sem resposta — ${p.motivoLegivel}`,
      sourceModule: "voice_calls",
      sourceId: row.id,
      // Quem atendeu assina. Sem isto a linha caía em `actor_kind='system'`.
      usuarioId: row.owner_user_id,
      agentId: row.owner_user_id ? null : (p.agentId ?? null),
      payload: { end_reason: p.endReason, answered: d.atendida },
    });
    if (!result.routed) {
      log.info("voz: ligação encerrada sem lead aberto, sem atividade", {
        contact_id: row.contact_id,
        reason: result.reason,
      });
    }
  }
}
