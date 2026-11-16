/**
 * O rastro do fim de uma ligação SIP — a ponte entre o worker de voz e o
 * módulo comum aos dois provedores (`lib/voice/fim-da-chamada.ts`).
 *
 * Antes disto a ligação SIP terminava só com a linha `ended` em `voice_calls`:
 * quem ligava e não era atendido não virava aviso na Central, e a ligação
 * atendida pela IA não aparecia na linha do tempo do negócio. A do WhatsApp
 * (WaCalls) já fazia as duas coisas.
 *
 * Nunca lança: o fim da ligação já foi gravado por quem chama, e um aviso que
 * não nasceu é melhor que um worker que cai no meio do atendimento seguinte.
 */
import type pg from "pg";

import { createPool } from "@/lib/agent-engine/db/pool";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { logger } from "@/lib/logger";
import { registrarFimDaLigacao, type LigacaoEncerrada } from "@/lib/voice/fim-da-chamada";
import { motivoDaLigacaoSip } from "@/lib/voip/motivo-da-ligacao";

let pool: pg.Pool | null = null;
function poolDoWorker(): pg.Pool | null {
  if (pool) return pool;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return null;
  pool = createPool(url, (err) =>
    logger.error("[voice-agent] pool: conexão caiu — recria no próximo uso", { err: err.message }),
  );
  return pool;
}

const logDoModulo: Logger = {
  info: (msg: string, f?: Record<string, unknown>) => logger.info(msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => logger.warn(msg, f),
  error: (msg: string, f?: Record<string, unknown>) => logger.error(msg, f),
};

export async function registrarFimDaLigacaoSip(p: {
  organizationId: string;
  ligacao: LigacaoEncerrada;
  endReason: string;
  agentId?: string | null;
  /** Passada ao time e ninguém atendeu — avisa mesmo se a IA atendeu antes. */
  timeNaoAtendeu?: boolean;
}): Promise<void> {
  const db = poolDoWorker();
  if (!db) {
    logger.warn("[voice-agent] SUPABASE_DB_URL ausente — fim da ligação sem aviso nem linha do tempo", {
      call_id: p.ligacao.id,
    });
    return;
  }
  try {
    await registrarFimDaLigacao(
      db,
      {
        organizationId: p.organizationId,
        ligacao: p.ligacao,
        endReason: p.endReason,
        motivoLegivel: motivoDaLigacaoSip(p.endReason),
        agentId: p.agentId ?? null,
        rotuloDaAtendida: p.ligacao.owner_user_id ? "Ligação atendida pelo time" : "Ligação atendida pela IA",
        payloadDoEvento: { provider: "sip" },
        timeNaoAtendeu: p.timeNaoAtendeu ?? false,
      },
      logDoModulo,
    );
  } catch (err) {
    logger.error("[voice-agent] falha ao registrar o fim da ligação", {
      call_id: p.ligacao.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
