/**
 * workers/voice-agent/ariClient.ts
 *
 * Cliente fino para a Asterisk REST Interface (ARI).
 * Duas superfícies:
 *  - REST: originar chamada, answer, hangup, setar variável, devolver canal
 *    pro dialplan (continueDialplan) — mídia em si vai por AudioSocket (TCP),
 *    não por aqui.
 *  - WebSocket: eventos Stasis (StasisStart, ChannelHangupRequest, etc.)
 *
 * Env esperadas:
 *  ARI_URL           ex: http://asterisk:8088
 *  ARI_WS_URL        ex: ws://asterisk:8088/ari/events
 *  ARI_USERNAME
 *  ARI_PASSWORD
 *  ARI_APP           nome da Stasis app, ex: "voice-agent"
 */

import WebSocket from "ws";

import { logger } from "@/lib/logger";

import { discagemPjsip } from "./discagem";

const ARI_URL = process.env.ARI_URL!;
const ARI_USERNAME = process.env.ARI_USERNAME!;
const ARI_PASSWORD = process.env.ARI_PASSWORD!;
const ARI_APP = process.env.ARI_APP ?? "voice-agent";

function authHeader() {
  const token = Buffer.from(`${ARI_USERNAME}:${ARI_PASSWORD}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function ariFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${ARI_URL}${path}`, {
    ...init,
    headers: { ...authHeader(), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ARI ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : null;
}

// ---------- Chamadas de saída (originate) ----------

export interface OriginateParams {
  toNumber: string;        // número de destino, ex: "5551999998888"
  fromNumber?: string;     // caller ID opcional
  trunkEndpoint: string;   // ex: "PJSIP/meu-trunk" (tech/nome-do-endpoint)
  callerLabel?: string;    // vira variable no dialplan, útil pra correlacionar com crm_calls
  /**
   * ID que o PRÓPRIO chamador escolhe pro canal (ARI aceita `channelId` no
   * create). Existe pra fechar uma race real: sem isto, `crm_calls.
   * asterisk_channel_id` só é gravado DEPOIS que o POST retorna — e o
   * StasisStart no worker (processo separado, via WebSocket) pode chegar
   * ANTES dessa segunda escrita, e o worker não acha a linha (visto ao vivo
   * num teste: "número s não mapeado", porque caiu no fallback de inbound).
   * Gerando o id ANTES e gravando na mesma INSERT que cria `crm_calls`,
   * elimina o gap — não tem update() separado esperando o retorno do ARI.
   */
  channelId: string;
}

/**
 * Origina uma chamada de saída e entrega direto pro dialplan (contexto
 * [voice-agent-out] em extensions.conf), NÃO pra Stasis app.
 *
 * Isto NÃO é o padrão ARI usual (a maioria dos exemplos manda pra Stasis) —
 * é assim de propósito: testado ao vivo que uma bridge ARI "mixing" com um
 * canal externalMedia nunca relay o áudio injetado de volta pro trunk (só
 * silêncio, confirmado por captura de payload em várias tentativas). O
 * dialplan chama AudioSocket(${AUDIOSOCKET_UUID}, voice-agent:9092) — TCP
 * puro, sem bridge nenhuma no meio, e o Asterisk cuida da transcodificação
 * pra PCM16 sozinho. `channelId` é reusado como o UUID do AudioSocket (é
 * uma string UUID válida de qualquer forma, gerada em route.ts) — assim o
 * worker sabe qual crm_calls essa conexão TCP corresponde assim que o
 * primeiro frame (tipo UUID) chega, sem StasisStart, sem race.
 */
export async function originateCall(params: OriginateParams) {
  // PJSIP rejeita "+" no dial string ("Could not create dialog to invalid
  // URI"), e o formato PJSIP/<endpoint>/<uri> falha para número cru (os dois
  // testados ao vivo). PJSIP/<destino>@<nome-do-endpoint> é o que funciona —
  // o Asterisk resolve host/porta pelo AOR do endpoint. A regra, e os dois
  // formatos de tronco que chegam aqui (env e tela), moram em `discagem.ts`.
  const endpoint = discagemPjsip(params.trunkEndpoint, params.toNumber);

  return ariFetch("/ari/channels", {
    method: "POST",
    body: JSON.stringify({
      endpoint,
      context: "voice-agent-out",
      extension: "s",
      priority: 1,
      channelId: params.channelId,
      callerId: params.fromNumber,
      variables: {
        AUDIOSOCKET_UUID: params.channelId,
        ...(params.callerLabel ? { CALL_LABEL: params.callerLabel } : {}),
      },
    }),
  });
}

// ---------- Controle de canal ----------

export async function answerChannel(channelId: string) {
  return ariFetch(`/ari/channels/${channelId}/answer`, { method: "POST" });
}

export async function hangupChannel(channelId: string, reason = "normal") {
  return ariFetch(`/ari/channels/${channelId}?reason=${reason}`, { method: "DELETE" });
}

// ---------- Entrega pro dialplan (AudioSocket, chamadas de ENTRADA) ----------
//
// externalMedia + bridge (RTP/UDP) foram REMOVIDOS daqui — testado ao vivo,
// várias variações (1 canal, 2 canais, portas únicas, marker bit RTP): uma
// bridge ARI "mixing" nunca relay áudio injetado por um canal externalMedia
// de volta pro outro membro, só manda silêncio. Limitação conhecida do
// chan_rtp/externalMedia do Asterisk pra esse padrão de uso — não bug
// nosso, confirmado por pesquisa na comunidade Asterisk. AudioSocket (TCP
// puro, sem bridge no meio) resolve por completo — ver
// workers/voice-agent/audioSocketBridge.ts.

/**
 * Seta uma variável de canal — usado pra passar o UUID do AudioSocket antes
 * de devolver o canal pro dialplan (`continueDialplan`).
 */
export async function setChannelVariable(channelId: string, variable: string, value: string) {
  return ariFetch(`/ari/channels/${channelId}/variable?variable=${encodeURIComponent(variable)}&value=${encodeURIComponent(value)}`, {
    method: "POST",
  });
}

/**
 * Devolve o controle do canal pro dialplan, num contexto/extensão/prioridade
 * específicos — usado pra sair da Stasis app depois que o worker já resolveu
 * a org/agente (chamada de ENTRADA) e seguir pro AudioSocket() no
 * extensions.conf, sem bridge nenhuma no meio.
 */
export async function continueDialplan(channelId: string, context: string, extension: string, priority = 1) {
  return ariFetch(`/ari/channels/${channelId}/continue`, {
    method: "POST",
    body: JSON.stringify({ context, extension, priority }),
  });
}

// ---------- Encaminhar ao time (atendimento humano, fase A) ----------
//
// A perna do time é originada PARA ESTA Stasis app (não para o dialplan): ela
// só entra na app quando o telefone do time atende, e aí o worker recebe um
// StasisStart com `args = ["time", <id da ligação>]`. Se ninguém atende no
// `timeout`, o canal é destruído sem nunca entrar na app (ChannelDestroyed).
// A ponte que junta as duas pernas é uma bridge "mixing" entre dois canais SIP
// — o caso que funciona; o que não funcionava era bridge com externalMedia.

export interface OriginarParaOTimeParams {
  /** String de discagem pronta (`discagemPjsip`). */
  endpoint: string;
  /** Id escolhido por nós — é como o StasisStart e o ChannelDestroyed voltam para o encaminhamento. */
  channelId: string;
  /** Id da linha em `voice_calls`, vai nos args do StasisStart. */
  callId: string;
  /** Segundos de toque antes de desistir. */
  timeout: number;
  /** Número de quem ligou, para o time ver quem é. */
  callerId?: string;
  /** Canal de quem ligou — o Asterisk relaciona as duas pernas. */
  originator?: string;
}

export async function originarParaOTime(p: OriginarParaOTimeParams) {
  return ariFetch("/ari/channels", {
    method: "POST",
    body: JSON.stringify({
      endpoint: p.endpoint,
      app: ARI_APP,
      appArgs: `time,${p.callId}`,
      channelId: p.channelId,
      timeout: p.timeout,
      ...(p.callerId ? { callerId: p.callerId } : {}),
      ...(p.originator ? { originator: p.originator } : {}),
    }),
  });
}

/** Toque de chamada para quem espera (o time ainda não atendeu). */
export async function tocarParaQuemEspera(channelId: string) {
  return ariFetch(`/ari/channels/${channelId}/ring`, { method: "POST" });
}

export async function pararDeTocar(channelId: string) {
  return ariFetch(`/ari/channels/${channelId}/ring`, { method: "DELETE" });
}

export async function criarPonte(): Promise<{ id: string }> {
  return ariFetch("/ari/bridges?type=mixing", { method: "POST" }) as Promise<{ id: string }>;
}

export async function porNaPonte(bridgeId: string, channelIds: string[]) {
  return ariFetch(`/ari/bridges/${bridgeId}/addChannel?channel=${channelIds.map(encodeURIComponent).join(",")}`, {
    method: "POST",
  });
}

export async function desfazerPonte(bridgeId: string) {
  return ariFetch(`/ari/bridges/${bridgeId}`, { method: "DELETE" });
}

// ---------- Eventos (WebSocket) ----------

/** Só os campos que o worker de voz lê — o envelope ARI real tem muito mais. */
export interface AriChannel {
  id: string;
  dialplan?: { exten?: string };
  caller?: { number?: string; name?: string };
}

export interface AriEvent {
  type: string;
  channel?: AriChannel;
  /** Só em StasisStart — os argumentos de `Stasis(app,args)` ou do `appArgs` do originate. */
  args?: string[];
  /** Só em ChannelDestroyed -- motivo do fim da chamada (texto ITU Q.850). */
  cause_txt?: string;
}

export type AriEventHandler = (event: AriEvent) => void | Promise<void>;

/** Espera da reconexão: 1 s, dobrando até 30 s; volta a 1 s quando conecta. */
export function esperaDaReconexao(tentativa: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, tentativa));
}

/**
 * Assina os eventos da Stasis app e SE RECONECTA quando a conexão cai.
 *
 * A conexão cai sempre que o Asterisk reinicia — inclusive na atualização, que
 * o recria (`recriar_a_telefonia`, update.sh). Antes, o fechamento só era
 * logado ("reconectar via supervisor do worker"), e não havia supervisor: o
 * processo seguia vivo, o healthcheck (porta do AudioSocket) seguia verde, e a
 * app deixava de existir no Asterisk — toda ligação recebida caía em
 * "Stasis app voice-agent doesn't exist" até alguém reiniciar o worker à mão.
 * Reconectar re-registra a app (ela existe enquanto houver um WebSocket dela).
 */
export function connectAriEvents(onEvent: AriEventHandler): { parar: () => void } {
  let tentativa = 0;
  let parado = false;
  let atual: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const conectar = () => {
    const wsUrl = `${process.env.ARI_WS_URL}?app=${ARI_APP}&api_key=${ARI_USERNAME}:${ARI_PASSWORD}&subscribeAll=true`;
    const ws = new WebSocket(wsUrl);
    atual = ws;

    ws.on("open", () => {
      if (tentativa > 0) logger.info("[ari] reconectado ao Asterisk", { tentativas: tentativa });
      tentativa = 0;
    });

    ws.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        void onEvent(event);
      } catch (err) {
        logger.error("[ari] evento inválido", { err: err instanceof Error ? err.message : String(err) });
      }
    });

    // `error` vem sempre seguido de `close` no `ws`: quem reagenda é só o close.
    ws.on("error", (err) => logger.warn("[ari] erro de websocket", { err: err.message }));

    ws.on("close", () => {
      if (parado) return;
      const espera = esperaDaReconexao(tentativa);
      tentativa += 1;
      logger.warn("[ari] conexão com o Asterisk caiu — reconectando", { em_ms: espera, tentativa });
      // SABOTAGEM: remover este agendamento = o caso "reconecta" de ari-reconecta.test.ts fica vermelho.
      timer = setTimeout(conectar, espera);
    });
  };

  conectar();
  return {
    parar: () => {
      parado = true;
      if (timer) clearTimeout(timer);
      atual?.close();
    },
  };
}
