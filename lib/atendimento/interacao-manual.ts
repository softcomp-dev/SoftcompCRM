import { z } from "zod";

import type { ActivityType } from "@/lib/leads/activity-vocabulary";

/**
 * A INTERAÇÃO QUE O VENDEDOR REGISTRA À MÃO no histórico de atendimento.
 *
 * O que acontece DENTRO do CRM (chat, ligação pelo VoIP ou pelo WhatsApp) entra
 * no histórico sozinho, lido das próprias tabelas (`lib/atendimento/historico.ts`).
 * O que acontece FORA — a ligação do celular, a reunião, a visita, o e-mail — só
 * existe se alguém contar. Esta é a porta para contar.
 *
 * ── Onde mora, e por que não é tabela nova ──────────────────────────────────
 * Em `crm_lead_activities`, como a nota do negócio. Lá a interação já nasce com
 * RLS, auditoria, exportação e anonimização da LGPD (o texto vai em `reason`,
 * que o redact apaga) e aparece na linha do tempo do negócio sem código novo.
 * O preço é que ela precisa de um NEGÓCIO (`lead_id` é NOT NULL): contato sem
 * negócio não registra interação, e a tela diz isso em vez de esconder.
 *
 * ── Por que não se edita ────────────────────────────────────────────────────
 * A linha do tempo é só de acréscimo para quem usa a tela (a RLS só tem
 * `select` e `insert`). Registro errado se corrige registrando outro — o
 * histórico conta o que foi dito, inclusive a correção.
 */

/** Como o contato aconteceu. `phone` é a ligação feita FORA do CRM (celular, fixo). */
export const CANAIS_DE_REGISTRO = ["phone", "whatsapp", "email", "meeting", "visit", "other"] as const;
export type CanalDeRegistro = (typeof CANAIS_DE_REGISTRO)[number];

/** Quem procurou quem. O mesmo vocabulário de `messages.direction`. */
export const DIRECOES = ["outbound", "inbound"] as const;
export type Direcao = (typeof DIRECOES)[number];

/** Falou com o cliente, ou tentou e não conseguiu. */
export const DESFECHOS = ["talked", "no_answer"] as const;
export type Desfecho = (typeof DESFECHOS)[number];

/**
 * O tipo da atividade sai do desfecho, e não de um campo dentro dela: quem decide
 * se a linha quebra o silêncio do negócio é o gatilho `fn_update_last_activity_at`,
 * que só enxerga `new.type`. Constantes, nunca literal no emissor
 * (`crm_lead_activities.type` é vocabulário aberto; só o TypeScript o vigia).
 */
export const TIPO_INTERACAO_REGISTRADA = "interaction_logged" as const satisfies ActivityType;
export const TIPO_TENTATIVA_REGISTRADA = "interaction_attempted" as const satisfies ActivityType;

export function tipoDaInteracao(desfecho: Desfecho): ActivityType {
  return desfecho === "talked" ? TIPO_INTERACAO_REGISTRADA : TIPO_TENTATIVA_REGISTRADA;
}

/** Relógio do navegador adiantado não pode recusar o registro de agora. */
const TOLERANCIA_DE_RELOGIO_MS = 5 * 60 * 1000;

/** Um dia inteiro. Acima disso não é duração de conversa, é erro de digitação. */
export const DURACAO_MAXIMA_MINUTOS = 24 * 60;

export const RESUMO_MAXIMO = 5000;

export const registrarInteracaoSchema = z
  .object({
    /** O negócio em que a interação entra. A rota confere que é deste contato. */
    lead_id: z.string().uuid(),
    channel: z.enum(CANAIS_DE_REGISTRO),
    direction: z.enum(DIRECOES),
    outcome: z.enum(DESFECHOS),
    /** O que foi conversado ou combinado. Obrigatório: interação sem conteúdo não ajuda quem vem depois. */
    summary: z.string().trim().min(1).max(RESUMO_MAXIMO),
    /** Quando aconteceu, se não foi agora ("liguei ontem à tarde"). */
    occurred_at: z
      .string()
      .datetime({ offset: true })
      .refine((v) => Date.parse(v) <= Date.now() + TOLERANCIA_DE_RELOGIO_MS, {
        message: "occurred_at não pode estar no futuro.",
      })
      .optional(),
    duration_minutes: z.number().int().min(0).max(DURACAO_MAXIMA_MINUTOS).optional(),
  })
  .strict();

export type RegistrarInteracaoInput = z.infer<typeof registrarInteracaoSchema>;

/**
 * O que vai no `payload` da atividade: só a forma do contato, nunca o texto.
 * O texto vai em `reason`, que é a coluna que a anonimização apaga e a linha do
 * tempo lê.
 */
export type PayloadDaInteracao = {
  channel: CanalDeRegistro;
  direction: Direcao;
  outcome: Desfecho;
  duration_minutes?: number;
};

export function payloadDaInteracao(input: RegistrarInteracaoInput): PayloadDaInteracao {
  return {
    channel: input.channel,
    direction: input.direction,
    outcome: input.outcome,
    ...(input.duration_minutes !== undefined ? { duration_minutes: input.duration_minutes } : {}),
  };
}
