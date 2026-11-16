/**
 * O motivo do fim de uma ligação SIP, em linguagem de gente.
 *
 * `voice_calls.end_reason` é livre de propósito (o vocabulário de `status` é
 * do WaCalls upstream; a granularidade da ligação SIP mora aqui). O worker de
 * voz (`workers/voice-agent`) grava estes valores; esta é a frase que chega ao
 * aviso da Central e à linha do tempo. Motivo desconhecido não é escondido: a
 * frase diz que não sabemos e mostra o valor cru.
 */
export const END_REASON_SEM_AGENTE = "no_agent";
export const END_REASON_ORG_PARADA = "org_inactive";
export const END_REASON_TIME_NAO_ATENDEU = "human_no_answer";
export const END_REASON_SEM_TELEFONE_DO_TIME = "human_unavailable";

const MOTIVOS: Record<string, string> = {
  user_ended: "A ligação terminou normalmente.",
  timeout: "O telefone tocou e ninguém atendeu.",
  busy: "A linha estava ocupada.",
  failed: "A ligação falhou antes de completar.",
  cancelled: "A ligação foi cancelada.",
  canceled: "A ligação foi cancelada.",
  declined: "A ligação foi recusada.",
  [END_REASON_SEM_AGENTE]:
    "Nenhum agente de voz estava ativo para atender. Ative um em IA › Agentes ou mude o atendimento do número para o time.",
  [END_REASON_ORG_PARADA]: "A empresa está suspensa ou arquivada, e a ligação não foi atendida.",
  [END_REASON_TIME_NAO_ATENDEU]: "A ligação foi passada ao time e ninguém atendeu o telefone do time.",
  [END_REASON_SEM_TELEFONE_DO_TIME]:
    "O número está configurado para passar ao time, mas a ligação não pôde ser encaminhada (telefone do time ausente ou recusado pela operadora).",
};

export function motivoDaLigacaoSip(motivo: string | null | undefined): string {
  const cru = (motivo ?? "").trim();
  if (!cru) return "A ligação terminou sem que a operadora informasse o motivo.";
  return MOTIVOS[cru.toLowerCase()] ?? `A ligação terminou por um motivo que ainda não sabemos traduzir (${cru}).`;
}
