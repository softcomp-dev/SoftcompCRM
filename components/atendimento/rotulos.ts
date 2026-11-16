import type { CanalDoHistorico } from "@/lib/atendimento/historico";
import type { CanalDeRegistro, Desfecho, Direcao } from "@/lib/atendimento/interacao-manual";

/**
 * As palavras do histórico de atendimento. Tabelas `const` no topo do módulo, e
 * a tela chama `t(TABELA[chave])`: é o formato que o guardião de espanhol sabe
 * ler (`tests/unit/helpers/chave-dinamica.ts`) — montar o texto por função o
 * deixaria cego para elas.
 */

/** Como o item se chama na lista. `phone` é a ligação feita FORA do CRM. */
export const ROTULO_DO_CANAL = {
  whatsapp_chat: "Conversa no WhatsApp",
  voip: "Ligação pelo CRM",
  whatsapp_call: "Ligação pelo WhatsApp",
  phone: "Ligação por fora do CRM",
  whatsapp: "WhatsApp por fora do CRM",
  email: "E-mail",
  meeting: "Reunião",
  visit: "Visita",
  other: "Outro contato",
} as const satisfies Record<CanalDoHistorico, string>;

/** As opções do diálogo de registro: só o que acontece fora do CRM. */
export const OPCAO_DE_CANAL = {
  phone: "Ligação (celular ou fixo)",
  whatsapp: "WhatsApp pelo celular",
  email: "E-mail",
  meeting: "Reunião (presencial ou on-line)",
  visit: "Visita",
  other: "Outro",
} as const satisfies Record<CanalDeRegistro, string>;

export const ROTULO_DA_DIRECAO = {
  outbound: "A equipe procurou o cliente",
  inbound: "O cliente procurou a equipe",
} as const satisfies Record<Direcao, string>;

export const ROTULO_DO_DESFECHO = {
  talked: "Conversou",
  no_answer: "Sem resposta",
} as const satisfies Record<Desfecho, string>;

export const OPCAO_DE_DESFECHO = {
  talked: "Falei com o cliente",
  no_answer: "Tentei, mas não consegui falar",
} as const satisfies Record<Desfecho, string>;
