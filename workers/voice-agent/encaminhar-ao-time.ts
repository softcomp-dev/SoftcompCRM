/**
 * ENCAMINHAR AO TIME — o atendimento humano da telefonia SIP, fase A.
 *
 * Nos modos "Time humano" e "IA, depois time humano" (`phone_numbers.routing_mode`),
 * a ligação vai para um telefone do time (`phone_numbers.forward_to_phone`,
 * migration 9255), discado pelo mesmo tronco SIP. O caminho:
 *
 *   1. a perna de quem ligou fica na Stasis desta app e ouve o toque;
 *   2. o worker origina a perna do time PARA a app (`originarParaOTime`), com o
 *      tempo de toque do número;
 *   3. o time atende → StasisStart `["time", <id da ligação>]` → as duas pernas
 *      entram numa ponte mixing e a linha vira `connected`;
 *   4. qualquer perna que cai derruba a outra e encerra a linha;
 *   5. o time não atende no tempo → a perna do time é destruída sem nunca ter
 *      entrado na app → a linha encerra com `human_no_answer`, o aviso
 *      "Ligar de volta" nasce na Central e quem ligou é desligado.
 *
 * A fase B — o telefone no navegador do atendente (WebRTC), sem custo de
 * minuto de saída — NÃO está aqui: docs/specs/33-spec-telefonia-sip-atendimento-humano.md.
 *
 * O estado mora em memória. Não há o que reconstruir depois de um reinício do
 * worker: a ponte morre junto, e o cron `recover-stuck-calls` fecha a linha
 * que ficou tocando.
 */
import { randomUUID } from "node:crypto";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LigacaoEncerrada } from "@/lib/voice/fim-da-chamada";
import {
  answerChannel,
  criarPonte,
  desfazerPonte,
  hangupChannel,
  originarParaOTime,
  pararDeTocar,
  porNaPonte,
  tocarParaQuemEspera,
} from "@/lib/voip/ariClient";
import { discagemPjsip } from "@/lib/voip/discagem";
import {
  END_REASON_SEM_TELEFONE_DO_TIME,
  END_REASON_TIME_NAO_ATENDEU,
} from "@/lib/voip/motivo-da-ligacao";

import { registrarFimDaLigacaoSip } from "./fim-sip";

const supabaseAdmin = createAdminClient();

export interface PedidoDeEncaminhar {
  /** Canal NATIVO de quem ligou (o `channel.id` do Asterisk). */
  canalDeQuemLigou: string;
  callId: string;
  organizationId: string;
  /** Telefone do time. */
  destino: string;
  /** Tronco por onde discar (`PJSIP/nome` ou só o nome da seção). */
  tronco: string;
  toqueSegundos: number;
  numeroDeQuemLigou: string;
  ligacao: Omit<LigacaoEncerrada, "answered_at">;
  /** `human` (direto) ou `ai_then_human` (a IA passou). */
  handledBy: "human" | "ai_then_human";
  /** Quando a IA atendeu antes (ai_then_human), o `answered_at` dela. */
  atendidaPelaIaEm?: string | null;
}

interface Encaminhamento extends PedidoDeEncaminhar {
  canalDoTime: string;
  ponteId: string | null;
  timeAtendeuEm: string | null;
  encerrado: boolean;
}

/** Chave: canal do time. */
const porCanalDoTime = new Map<string, Encaminhamento>();
/** Chave: canal de quem ligou → canal do time. */
const porCanalDeQuemLigou = new Map<string, string>();

const COLUNAS_DO_FIM = "id, organization_id, contact_id, answered_at, peer_phone, owner_user_id, direction";

async function silencioso(p: Promise<unknown>, oQue: string, ctx: Record<string, unknown>) {
  try {
    await p;
  } catch (err) {
    logger.warn(`[time] ${oQue} falhou`, { ...ctx, err: err instanceof Error ? err.message : String(err) });
  }
}

async function encerrarLinha(
  e: PedidoDeEncaminhar,
  endReason: string,
  extra: Record<string, unknown>,
  timeNaoAtendeu: boolean,
) {
  const { data, error } = await supabaseAdmin
    .from("voice_calls")
    .update({ status: "ended", end_reason: endReason, ended_at: new Date().toISOString(), ...extra })
    .eq("id", e.callId)
    .eq("organization_id", e.organizationId)
    .neq("status", "ended")
    .select(COLUNAS_DO_FIM)
    .maybeSingle();
  if (error) {
    logger.error("[time] falha ao encerrar a ligação", { call_id: e.callId, err: error.message });
    return;
  }
  if (!data) return; // outro caminho já encerrou
  await registrarFimDaLigacaoSip({
    organizationId: e.organizationId,
    ligacao: data as LigacaoEncerrada,
    endReason,
    timeNaoAtendeu,
  });
}

/**
 * Começa o encaminhamento. Nunca lança: falha de originate encerra a ligação
 * com motivo e aviso, em vez de deixá-la tocando para ninguém.
 */
export async function encaminharAoTime(p: PedidoDeEncaminhar): Promise<void> {
  const canalDoTime = randomUUID();
  const enc: Encaminhamento = { ...p, canalDoTime, ponteId: null, timeAtendeuEm: null, encerrado: false };
  porCanalDoTime.set(canalDoTime, enc);
  porCanalDeQuemLigou.set(p.canalDeQuemLigou, canalDoTime);

  await supabaseAdmin
    .from("voice_calls")
    .update({ handled_by: p.handledBy })
    .eq("id", p.callId)
    .eq("organization_id", p.organizationId);

  await silencioso(tocarParaQuemEspera(p.canalDeQuemLigou), "toque para quem espera", { call_id: p.callId });

  try {
    await originarParaOTime({
      endpoint: discagemPjsip(p.tronco, p.destino),
      channelId: canalDoTime,
      callId: p.callId,
      timeout: p.toqueSegundos,
      callerId: p.numeroDeQuemLigou,
      originator: p.canalDeQuemLigou,
    });
    logger.info("[time] ligação encaminhada ao telefone do time", {
      call_id: p.callId,
      toque_s: p.toqueSegundos,
      modo: p.handledBy,
    });
  } catch (err) {
    logger.error("[time] a operadora recusou discar para o telefone do time", {
      call_id: p.callId,
      err: err instanceof Error ? err.message : String(err),
    });
    enc.encerrado = true;
    esquecer(enc);
    await encerrarLinha(p, END_REASON_SEM_TELEFONE_DO_TIME, {}, true);
    await silencioso(hangupChannel(p.canalDeQuemLigou, "normal"), "desligar quem ligou", { call_id: p.callId });
  }
}

function esquecer(enc: Encaminhamento) {
  porCanalDoTime.delete(enc.canalDoTime);
  porCanalDeQuemLigou.delete(enc.canalDeQuemLigou);
}

/** StasisStart com `args[0] === "time"`: o telefone do time atendeu. */
export async function quandoOTimeAtende(canalDoTime: string): Promise<void> {
  const enc = porCanalDoTime.get(canalDoTime);
  if (!enc || enc.encerrado) {
    // Atendeu depois de quem ligou desistir (ou o worker reiniciou): não há com quem falar.
    await silencioso(hangupChannel(canalDoTime, "normal"), "desligar perna órfã do time", { canal: canalDoTime });
    return;
  }
  try {
    await silencioso(pararDeTocar(enc.canalDeQuemLigou), "parar o toque", { call_id: enc.callId });
    // Na passagem pela IA a perna já está atendida; atender de novo só falha.
    if (!enc.atendidaPelaIaEm) await answerChannel(enc.canalDeQuemLigou);
    const ponte = await criarPonte();
    enc.ponteId = ponte.id;
    await porNaPonte(ponte.id, [enc.canalDeQuemLigou, canalDoTime]);
  } catch (err) {
    logger.error("[time] falha ao juntar as duas pernas", {
      call_id: enc.callId,
      err: err instanceof Error ? err.message : String(err),
    });
    await encerrarAsDuas(enc, END_REASON_SEM_TELEFONE_DO_TIME, true);
    return;
  }

  enc.timeAtendeuEm = new Date().toISOString();
  await supabaseAdmin
    .from("voice_calls")
    .update({
      status: "connected",
      // A ligação passada pela IA já foi atendida (pela IA): o answered_at fica o dela.
      ...(enc.atendidaPelaIaEm ? {} : { answered_at: enc.timeAtendeuEm }),
    })
    .eq("id", enc.callId)
    .eq("organization_id", enc.organizationId)
    .neq("status", "ended");
  logger.info("[time] o time atendeu", { call_id: enc.callId });
}

async function encerrarAsDuas(enc: Encaminhamento, endReason: string, timeNaoAtendeu: boolean) {
  if (enc.encerrado) return;
  enc.encerrado = true;
  esquecer(enc);
  const inicio = enc.atendidaPelaIaEm ?? enc.timeAtendeuEm;
  const extra = inicio ? { duration_ms: Date.now() - new Date(inicio).getTime() } : {};
  await encerrarLinha(enc, endReason, extra, timeNaoAtendeu);
  if (enc.ponteId) await silencioso(desfazerPonte(enc.ponteId), "desfazer a ponte", { call_id: enc.callId });
  await silencioso(hangupChannel(enc.canalDoTime, "normal"), "desligar o time", { call_id: enc.callId });
  await silencioso(hangupChannel(enc.canalDeQuemLigou, "normal"), "desligar quem ligou", { call_id: enc.callId });
}

/**
 * ChannelDestroyed de qualquer canal. Devolve `true` quando o canal era de um
 * encaminhamento (e então o handler genérico não precisa fazer nada).
 */
export async function quandoUmCanalCai(channelId: string): Promise<boolean> {
  const doTime = porCanalDoTime.get(channelId);
  if (doTime) {
    if (doTime.timeAtendeuEm) {
      // O time desligou depois de falar: fim normal.
      await encerrarAsDuas(doTime, "user_ended", false);
    } else {
      // Tocou o tempo todo e ninguém atendeu (ou estava ocupado, ou a operadora recusou).
      // SABOTAGEM: trocar `true` por `false` = o caso "a IA passou e ninguém atendeu" fica sem aviso (vermelho).
      await encerrarAsDuas(doTime, END_REASON_TIME_NAO_ATENDEU, true);
    }
    return true;
  }

  const canalDoTime = porCanalDeQuemLigou.get(channelId);
  if (canalDoTime) {
    const enc = porCanalDoTime.get(canalDoTime);
    if (!enc) return false;
    if (enc.timeAtendeuEm) {
      await encerrarAsDuas(enc, "user_ended", false);
      return true;
    }
    // Quem ligou desistiu enquanto o time tocava. Na passagem direta a linha
    // ainda está `ringing`: o handler genérico a fecha como `timeout` (e avisa).
    // Na passagem pela IA ela está `connected`, e é este caminho que fecha.
    if (enc.atendidaPelaIaEm) {
      await encerrarAsDuas(enc, END_REASON_TIME_NAO_ATENDEU, true);
      return true;
    }
    enc.encerrado = true;
    esquecer(enc);
    await silencioso(hangupChannel(enc.canalDoTime, "normal"), "desligar o time", { call_id: enc.callId });
    return false;
  }
  return false;
}

/** Só para teste. */
export function _limparEncaminhamentos() {
  porCanalDoTime.clear();
  porCanalDeQuemLigou.clear();
}
