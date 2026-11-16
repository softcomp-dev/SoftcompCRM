/**
 * workers/voice-agent/index.ts
 *
 * Processo persistente (mesmo padrão dos outros workers/ — roda no
 * Dockerfile.voice-agent via tsx, um processo, sem HTTP exposto pra fora).
 *
 * TODA mídia (entrada e saída) vai por AudioSocket (TCP puro,
 * audioSocketBridge.ts), não por RTP/externalMedia/bridge ARI. Motivo:
 * testado ao vivo (28/08) que bridge de mixing do Asterisk nunca relay
 * áudio injetado por um canal externalMedia de volta pro outro membro — só
 * silêncio. Limitação conhecida do chan_rtp/externalMedia pra esse padrão
 * de uso, não bug nosso.
 *
 * Grava em `voice_calls` (provider='sip'), não numa tabela própria —
 * unificada com a chamada de voz por WhatsApp (WaCalls, #628/#697) na
 * migration 0348, porque duas tabelas de chamada que não conversam era o
 * primeiro problema que a triagem do PR #677 apontou. O vocabulário de
 * `status` (starting/ringing/connected/ended) é do binário WaCalls
 * upstream — reaproveitado aqui, não estendido; granularidade extra
 * (no_answer/busy/failed/canceled) vai em `end_reason`, livre de propósito.
 *
 * Dois fluxos:
 *  - SAÍDA (POST /api/v1/calls): originateCall já entrega direto pro
 *    dialplan [voice-agent-out] (context/extension no create, não app) —
 *    esse canal NUNCA passa pela Stasis app deste worker.
 *  - ENTRADA (from-trunk): entra na Stasis só de PASSAGEM — o suficiente
 *    pra resolver org/agente pelo número discado e criar a linha em
 *    voice_calls — e devolve o controle pro dialplan (continueDialplan) rumo
 *    ao [from-trunk-audiosocket], que chama AudioSocket() igual à saída.
 *
 * Os dois fluxos convergem no mesmo lugar: startAudioSocketServer() aceita
 * a conexão TCP, lê o frame de UUID, acha a linha em voice_calls por
 * asterisk_channel_id (== o UUID, de propósito) e sobe UMA
 * AudioSocketCallBridge — não importa se a chamada é de entrada ou saída.
 *
 * Sem publicação em event_log (call.ended etc.): nenhum handler em
 * lib/event-log/register-handlers.ts consumiria esses tipos ainda — ver nota
 * na migration 0347. Sumarização/sentimento pós-chamada fica fora do escopo
 * deste esqueleto até existir consumidor real.
 */

import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  connectAriEvents,
  hangupChannel,
  setChannelVariable,
  continueDialplan,
  type AriEvent,
} from "@/lib/voip/ariClient";
import { AudioSocketCallBridge } from "./audioSocketBridge";
import { idsDaLinhaDoCanal, uuidDoAudioSocketDeEntrada } from "./canal-de-entrada";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveVoiceAgent } from "@/lib/ai/agents";
import { resolveOrCreateCallerContact, type ContatoDaChamada } from "@/lib/voip/resolve-caller";
import {
  deveRecusarChamada,
  deveRecusarChamadaPessoal,
  END_REASON_CONTACT_BLOCKED,
  END_REASON_CONTACT_PERSONAL,
} from "./recusa-bloqueado";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { buscarConhecimento, resolverAcervoDoAgente } from "@/lib/ai/knowledge/busca";
import { ehOperante } from "@/lib/organizacao/operante";
import { registrarChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";
import { logger } from "@/lib/logger";
import { linhaDaLigacao } from "./uso-da-sessao";
import { registrarFimDaLigacaoSip } from "./fim-sip";
import { encaminharAoTime, quandoOTimeAtende, quandoUmCanalCai } from "./encaminhar-ao-time";
import { iniciarAplicacaoDoTronco } from "./aplicar-tronco";
import { organizacaoDoEndpoint } from "@/lib/voip/tronco-dinamico";
import type { LigacaoEncerrada } from "@/lib/voice/fim-da-chamada";
import {
  END_REASON_ORG_PARADA,
  END_REASON_SEM_AGENTE,
  END_REASON_SEM_TELEFONE_DO_TIME,
} from "@/lib/voip/motivo-da-ligacao";

const supabaseAdmin = createAdminClient();

const AUDIOSOCKET_PORT = parseInt(process.env.AUDIOSOCKET_PORT ?? "9092", 10);

// ---------- Stasis (só ENTRADA, só de passagem) ----------

/**
 * Exportada para o teste do fio (`fio-recusa-bloqueado.test.ts`) provar que
 * este caminho USA `deveRecusarChamada` — função pura órfã não conta como
 * implementação.
 */
export async function handleStasisStart(event: AriEvent) {
  const channel = event.channel;
  if (!channel) return;

  // chamada de entrada: resolve o tenant pelo número discado (phone_numbers)
  const dialedNumber = channel.dialplan?.exten ?? "unknown";
  // O tronco por onde a ligação chegou (`Stasis(voice-agent,inbound,${CHANNEL(endpoint)})`
  // em extensions.conf). O tronco salvo na tela tem o id da organização no nome.
  const organizacaoDoTronco = organizacaoDoEndpoint(event.args?.[1]);
  const routing = await resolveInboundNumber(dialedNumber, organizacaoDoTronco);
  if (!routing) {
    logger.error("[voice-agent] número discado não mapeado em phone_numbers", { extensao_s: dialedNumber === "s" });
    await hangupChannel(channel.id, "normal");
    return;
  }

  const callerNumber = channel.caller?.number ?? "unknown";

  // Identificador de ligações: acha (ou cria) o contato pelo número de quem
  // liga, com o bloqueio lido na mesma consulta. Não bloqueia a chamada se
  // falhar — o pior caso é a tela mostrar só o número, igual antes desta
  // função existir. Fail-open: erro de leitura loga e segue,
  // nunca recusa no escuro.
  let contatoDeQuemLiga: ContatoDaChamada | null = null;
  try {
    contatoDeQuemLiga = await resolveOrCreateCallerContact(
      supabaseAdmin,
      routing.organization_id,
      callerNumber,
    );
  } catch (err) {
    logger.error("[voice-agent] falha ao resolver o contato de quem liga", {
      organization_id: routing.organization_id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const callerContactId = contatoDeQuemLiga?.id ?? null;

  // BLOQUEADO NA LIGAÇÃO É RECUSADO: depois do contato resolvido,
  // antes do insert, antes do dialplan e antes da IA. Grava a linha já
  // encerrada (rastreável no histórico como Cancelada) e
  // desliga — sem negócio, sem IA, sem tocar, sem alerta.
  // SABOTAGEM DO FIO: remover a chamada a `deveRecusarChamada` abaixo (manter
  // a função pura existindo mas sem uso) = teste do fio vermelho.
  if (deveRecusarChamada(contatoDeQuemLiga?.is_blocked)) {
    const agora = new Date().toISOString();
    const { error: refuseError } = await supabaseAdmin.from("voice_calls").insert({
      organization_id: routing.organization_id,
      provider: "sip",
      direction: "inbound",
      status: "ended",
      end_reason: END_REASON_CONTACT_BLOCKED,
      peer_phone: callerNumber,
      contact_id: callerContactId,
      asterisk_channel_id: randomUUID(),
      started_at: agora,
      answered_at: null,
      ended_at: agora,
    });
    if (refuseError) {
      logger.error("[voice-agent] falha ao gravar recusa de bloqueado", { err: refuseError.message });
    } else {
      logger.info("[voice-agent] chamada recusada de bloqueado", { organization_id: routing.organization_id });
    }
    await hangupChannel(channel.id, "normal");
    return;
  }

  // PESSOAL NA LIGAÇÃO É RECUSADO COMO BLOQUEADO (spec 21, etapa 14 —
  // critério 11): depois do contato resolvido, antes do insert, antes do
  // dialplan e antes da IA. Grava a linha já encerrada (ESCONDIDA do
  // histórico, como a mensagem — volta ao desmarcar) e desliga — sem negócio,
  // sem IA, sem tocar, sem alerta. `end_reason` próprio, nunca o de bloqueio.
  // SABOTAGEM DO FIO: remover a chamada a `deveRecusarChamadaPessoal` abaixo
  // (manter a função pura existindo mas sem uso) = teste do fio vermelho.
  if (deveRecusarChamadaPessoal(contatoDeQuemLiga?.is_personal)) {
    const agora = new Date().toISOString();
    const { error: refuseError } = await supabaseAdmin.from("voice_calls").insert({
      organization_id: routing.organization_id,
      provider: "sip",
      direction: "inbound",
      status: "ended",
      end_reason: END_REASON_CONTACT_PERSONAL,
      peer_phone: callerNumber,
      contact_id: callerContactId,
      asterisk_channel_id: randomUUID(),
      started_at: agora,
      answered_at: null,
      ended_at: agora,
    });
    if (refuseError) {
      logger.error("[voice-agent] falha ao gravar recusa de pessoal", { err: refuseError.message });
    } else {
      logger.info("[voice-agent] chamada recusada de pessoal", { organization_id: routing.organization_id });
    }
    await hangupChannel(channel.id, "normal");
    return;
  }

  // channel.id é o identificador NATIVO do canal no Asterisk (formato
  // "<epoch>.<sequencia>", ex.: "1789081888.0") — válido pras chamadas REST
  // do ARI (hangup/setChannelVariable/continueDialplan), mas NAO é um UUID:
  // app_audiosocket.c rejeita com "Failed to parse UUID" se receber isto
  // (visto ao vivo, toda chamada de entrada). Na SAÍDA isso nunca aparece
  // porque lá QUEM escolhe channel.id somos nós (route.ts gera o UUID e
  // passa em `channelId` pro ARI no originate) — na ENTRADA o Asterisk já
  // criou o canal, com o id dele, antes deste código rodar. Por isso aqui
  // se usa um UUID SEPARADO só pra correlação do AudioSocket/voice_calls;
  // as chamadas ARI continuam endereçando o canal por channel.id. Ele é
  // DERIVADO do channel.id, não sorteado: é assim que o ChannelDestroyed
  // reencontra esta linha quando o AudioSocket nunca conecta (canal-de-entrada.ts).
  const audioSocketUuid = uuidDoAudioSocketDeEntrada(channel.id);

  const { data: callRow, error } = await supabaseAdmin
    .from("voice_calls")
    .insert({
      organization_id: routing.organization_id,
      provider: "sip",
      direction: "inbound",
      status: "ringing",
      peer_phone: callerNumber,
      contact_id: callerContactId,
      asterisk_channel_id: audioSocketUuid,
      // O agente que o número aponta (Telefonia). Quem atende lê daqui.
      ai_agent_id: routing.default_ai_agent_id,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error || !callRow) {
    logger.error("[voice-agent] falha ao criar voice_calls pra chamada de entrada", { err: error?.message });
    await hangupChannel(channel.id, "normal");
    return;
  }

  // A ligação é uma demanda nova, igual a uma mensagem de WhatsApp: sem isto,
  // quem liga e não é atendido fica de fora do funil e do radar de risco (os
  // dois trabalham sobre crm_leads, não sobre voice_calls). Idempotente por
  // contato — reusa o mesmo mecanismo do WhatsApp (nascimento-do-lead.ts),
  // só troca o rótulo/source de origem. Best-effort: não derruba a ligação.
  if (callerContactId) {
    try {
      const nascimento = await garantirLeadDaConversa(supabaseAdmin, {
        organizationId: routing.organization_id,
        contactId: callerContactId,
        conversationId: callRow.id,
        nomeDoContato: channel.caller?.name ?? null,
        origem: { rotulo: "telefone", source: "voip", motivo: "primeira ligação recebida" },
      });
      if (!nascimento.criado) {
        logger.info("[voice-agent] lead não criado para quem ligou", { call_id: callRow.id, motivo: nascimento.motivo });
      }
    } catch (err) {
      logger.error("[voice-agent] falha ao garantir lead da chamada", {
        call_id: callRow.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // MODO "TIME HUMANO": a ligação não passa pela IA — vai direto ao telefone do
  // time (encaminhar-ao-time.ts), e a perna de quem ligou fica aqui na Stasis.
  // Sem telefone do time (dado anterior à validação da tela), encerra com o
  // motivo e o aviso em vez de deixar tocando para ninguém.
  // SABOTAGEM: remover este bloco = o caso "time humano" de fio-encaminhar-ao-time fica vermelho.
  if (routing.routing_mode === "human") {
    if (!routing.forward_to_phone) {
      await encerrarSemAtender(callRow.id, END_REASON_SEM_TELEFONE_DO_TIME);
      await hangupChannel(channel.id, "normal");
      return;
    }
    await encaminharAoTime({
      canalDeQuemLigou: channel.id,
      callId: callRow.id,
      organizationId: routing.organization_id,
      destino: routing.forward_to_phone,
      tronco: await troncoDaOrganizacao(routing.organization_id, routing.trunk_endpoint),
      toqueSegundos: routing.forward_ring_seconds ?? 25,
      numeroDeQuemLigou: callerNumber,
      ligacao: {
        id: callRow.id,
        contact_id: callerContactId,
        peer_phone: callerNumber,
        owner_user_id: null,
        direction: "inbound",
      },
      handledBy: "human",
    });
    return;
  }

  // MODO "IA, DEPOIS TIME HUMANO": a IA atende, e guarda-se para onde passar.
  // Sem telefone do time a ligação segue só com a IA — a ferramenta de passar
  // nem é oferecida ao modelo (prometer transferência sem destino seria mentir).
  if (routing.routing_mode === "ai_then_human" && routing.forward_to_phone) {
    passagensPossiveis.set(callRow.id, {
      canalNativo: channel.id,
      destino: routing.forward_to_phone,
      tronco: await troncoDaOrganizacao(routing.organization_id, routing.trunk_endpoint),
      toqueSegundos: routing.forward_ring_seconds ?? 25,
      numeroDeQuemLigou: callerNumber,
      atendidaPelaIaEm: null,
    });
  }

  // audioSocketUuid é o asterisk_channel_id gravado acima — vai como UUID do
  // AudioSocket (mesmo padrão da saída), pra handleAudioSocketConnection
  // achar a linha certa assim que a conexão TCP chegar.
  await setChannelVariable(channel.id, "AUDIOSOCKET_UUID", audioSocketUuid);
  await continueDialplan(channel.id, "from-trunk-audiosocket", "s", 1);
}

/**
 * Ligações em modo "IA, depois time humano" que a IA pode passar adiante.
 * Chave: id da linha em `voice_calls`. Em memória de propósito: reiniciado o
 * worker, a sessão de voz morre junto e não há o que passar.
 */
interface PassagemPossivel {
  canalNativo: string;
  destino: string;
  tronco: string;
  toqueSegundos: number;
  numeroDeQuemLigou: string;
  /** Preenchido quando a IA pede a passagem: o answered_at da IA. */
  atendidaPelaIaEm: string | null;
  ligacao?: Omit<LigacaoEncerrada, "answered_at">;
}
const passagensPossiveis = new Map<string, PassagemPossivel>();

type RoteamentoInbound = {
  organization_id: string;
  routing_mode: "ai" | "human" | "ai_then_human";
  default_ai_agent_id: string | null;
  fallback_user_id: string | null;
  /** Telefone do time (migration 9255) — modos human e ai_then_human. */
  forward_to_phone: string | null;
  forward_ring_seconds: number | null;
  trunk_endpoint: string | null;
};

/**
 * Por onde discar para o time: o tronco que a organização salvou na tela
 * (Configurações › Trunk SIP), e, sem ele, o do número (o `VOIP_TRUNK_ENDPOINT`
 * de quando o número foi cadastrado). Mesma precedência do `POST /api/v1/calls`.
 */
async function troncoDaOrganizacao(organizationId: string, doNumero: string | null): Promise<string> {
  const { data } = await supabaseAdmin
    .from("voip_trunk_settings")
    .select("endpoint_name, is_active")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const daTela = data as { endpoint_name?: string | null; is_active?: boolean } | null;
  if (daTela?.is_active && daTela.endpoint_name) return daTela.endpoint_name;
  return doNumero ?? process.env.VOIP_TRUNK_ENDPOINT ?? "";
}

async function resolveInboundNumber(
  dialedNumber: string,
  organizacaoDoTronco: string | null = null,
): Promise<RoteamentoInbound | null> {
  // Trunks de DID único mandam a extensão "s" no Request-URI em vez dos
  // dígitos do número discado (ver extensions.conf, contexto [from-trunk] —
  // "extension not found" antes desta função nem rodar era o sintoma).  Sem
  // DNIS real não dá pra saber QUAL número foi discado — mas com exatamente
  // UM número ativo cadastrado não tem ambiguidade nenhuma: só pode ser ele.
  // Se um dia existir mais de um, isto recusa (ambíguo) em vez de adivinhar.
  //
  // Com o tronco da tela, a ligação diz por qual tronco chegou — e o tronco é de
  // UMA organização. Aí a pergunta vira "um número ativo NESTA organização", e
  // várias empresas podem ter cada uma o seu tronco de DID único na mesma VPS.
  if (dialedNumber === "s") {
    let consulta = supabaseAdmin
      .from("phone_numbers")
      .select(
        "organization_id, routing_mode, default_ai_agent_id, fallback_user_id, forward_to_phone, forward_ring_seconds, trunk_endpoint",
      )
      .eq("is_active", true);
    // SABOTAGEM: remover este filtro = o caso "duas empresas" de fio-tronco-da-organizacao fica vermelho.
    if (organizacaoDoTronco) consulta = consulta.eq("organization_id", organizacaoDoTronco);
    const { data, error } = await consulta.limit(2);
    if (error || !data || data.length !== 1) {
      logger.error(
        '[voice-agent] extensão "s" (trunk de DID único) só resolve com exatamente 1 número ativo',
        { encontrados: data?.length ?? 0 },
      );
      return null;
    }
    return data[0] as RoteamentoInbound;
  }

  const { data, error } = await supabaseAdmin
    .rpc("fn_resolve_inbound_number", { p_number: dialedNumber })
    .single();
  if (error || !data) return null;
  return data as RoteamentoInbound;
}

// ---------- AudioSocket (entrada E saída convergem aqui) ----------

interface ActiveAudioSocketCall {
  bridge: AudioSocketCallBridge;
  callRowId: string;
  organizationId: string;
  agentId: string;
  contactId: string | null;
  answeredAt: string;
  transcript: { speaker: string; text: string; ts: string }[];
  /** O que o fim da ligação precisa para o aviso e a linha do tempo. */
  ligacao: Omit<LigacaoEncerrada, "answered_at">;
}

/** Colunas que o rastro do fim (`./fim-sip.ts`) lê da linha encerrada. */
const COLUNAS_DO_FIM = "id, organization_id, contact_id, answered_at, peer_phone, owner_user_id, direction";

type LinhaDoFim = LigacaoEncerrada & { organization_id: string };

/**
 * A ligação que chegou ao AudioSocket mas não vai ser atendida pela IA
 * (organização parada, nenhum agente de voz): encerra a linha com o motivo e
 * deixa o rastro. Sem isto ela ficava "tocando" até o canal sumir e virava
 * um `timeout` que dizia "ninguém atendeu" quando o defeito era configuração.
 * Só encerra linha que ainda toca — a recusada pela tela já está `ended`.
 */
async function encerrarSemAtender(callId: string, endReason: string) {
  const { data, error } = await supabaseAdmin
    .from("voice_calls")
    .update({ status: "ended", end_reason: endReason, ended_at: new Date().toISOString() })
    .eq("id", callId)
    .in("status", ["starting", "ringing"])
    .select(COLUNAS_DO_FIM)
    .maybeSingle();
  if (error) {
    logger.error("[audiosocket] falha ao encerrar ligação não atendida", { call_id: callId, err: error.message });
    return;
  }
  const linha = data as LinhaDoFim | null;
  if (!linha) return;
  await registrarFimDaLigacaoSip({ organizationId: linha.organization_id, ligacao: linha, endReason });
}
const activeAudioSocketCalls = new Map<string, ActiveAudioSocketCall>(); // key = uuid (== voice_calls.asterisk_channel_id)

function bytesToUuid(buf: Buffer): string {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function appendAudioSocketTranscriptTurn(uuid: string, turn: { speaker: string; text: string }) {
  const call = activeAudioSocketCalls.get(uuid);
  if (!call) return;
  call.transcript.push({ ...turn, ts: new Date().toISOString() });
}

async function finalizeAudioSocketCall(uuid: string) {
  const call = activeAudioSocketCalls.get(uuid);
  if (!call) return;
  activeAudioSocketCalls.delete(uuid);

  const endedAt = new Date();
  // duration_ms não é generated column em voice_calls (era em crm_calls) —
  // calcula na mão a partir do answered_at que a gente mesmo gravou.
  const durationMs = endedAt.getTime() - new Date(call.answeredAt).getTime();

  const passagem = passagensPossiveis.get(call.callRowId);
  // SABOTAGEM: trocar a condição por `false` = o caso "passa ao time" de fio-passar-ao-time
  // fica vermelho (a linha encerra e o time nunca é chamado).
  if (passagem && call.bridge.pediuOTime()) {
    // A IA passou ao time: a sessão de IA acabou, a LIGAÇÃO não. A linha fica
    // `connected` e o canal volta à Stasis pelo dialplan (args "transferir").
    passagem.atendidaPelaIaEm = call.answeredAt;
    passagem.ligacao = call.ligacao;
    await supabaseAdmin
      .from("voice_calls")
      .update({ handled_by: "ai_then_human", transcript: call.transcript })
      .eq("id", call.callRowId)
      .eq("organization_id", call.organizationId);
  } else {
    passagensPossiveis.delete(call.callRowId);
    await supabaseAdmin
      .from("voice_calls")
      .update({
        status: "ended",
        end_reason: "user_ended",
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        transcript: call.transcript,
      })
      .eq("id", call.callRowId);

    // Aviso, `voice_call.ended` e linha do tempo — o mesmo rastro da ligação do
    // WhatsApp. Nunca lança.
    await registrarFimDaLigacaoSip({
      organizationId: call.organizationId,
      ligacao: { ...call.ligacao, answered_at: call.answeredAt },
      endReason: "user_ended",
      agentId: call.agentId,
    });
  }

  // ─── O uso da sessão vai para `llm_calls` ───────────────────────────────
  //
  // Sem isto a voz — o gasto mais caro por minuto do produto — não aparecia
  // em Uso de IA. Tokens medidos pela própria OpenAI (`response.done`), duração
  // da ligação em `latency_ms`, custo nulo por limitação declarada (tarifa de
  // áudio fora do catálogo — ver `./uso-da-sessao.ts`). Nunca lança.
  const sessao = call.bridge.usoDaSessao();
  await registrarChamadaDeIa(
    supabaseAdmin,
    linhaDaLigacao({
      organizationId: call.organizationId,
      agentId: call.agentId,
      contactId: call.contactId,
      modelo: sessao.modelo,
      uso: sessao.uso,
      duracaoMs: durationMs,
      erro: sessao.erro,
    }),
  );
  logger.info("[voice-agent] uso da ligação registrado", {
    organization_id: call.organizationId,
    call_id: call.callRowId,
    model: sessao.modelo,
    respostas: sessao.uso.respostas,
    entrada_audio: sessao.uso.entradaAudio,
    entrada_texto: sessao.uso.entradaTexto,
    entrada_cache: sessao.uso.entradaCache,
    saida_audio: sessao.uso.saidaAudio,
    saida_texto: sessao.uso.saidaTexto,
    duracao_ms: durationMs,
  });
}

export async function handleAudioSocketConnection(socket: net.Socket, uuid: string, leftover: Buffer) {
  const { data: callRow, error } = await supabaseAdmin
    .from("voice_calls")
    .select("*")
    .eq("asterisk_channel_id", uuid)
    .single();

  if (error || !callRow) {
    logger.error("[audiosocket] uuid não corresponde a nenhuma voice_calls — encerrando", { uuid });
    socket.end();
    return;
  }

  // Recusada pela tela enquanto tocava (`lib/voip/recusar-chamada-sip.ts`): a
  // linha já está `ended`. Fechar o socket devolve o canal ao dialplan, que
  // desliga (`Hangup()` em [from-trunk-audiosocket]) — sem abrir a sessão de IA,
  // que é paga por minuto, e sem regravar a linha como `connected`.
  // SABOTAGEM: remover este bloco = o caso "recusada" de fio-recusada-pela-tela fica vermelho.
  if (callRow.status === "ended") {
    logger.info("[audiosocket] chamada já encerrada — desligando", {
      call_id: callRow.id,
      end_reason: callRow.end_reason ?? null,
    });
    socket.end();
    return;
  }

  // Organização parada (suspensa, redigida, arquivada) não atende por voz: a
  // sessão em tempo real é o gasto mais caro por minuto do produto. Falha de
  // leitura também encerra — sem saber o status, não se abre a sessão paga.
  const { data: org, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .select("status")
    .eq("id", callRow.organization_id)
    .maybeSingle();
  if (orgErr || !ehOperante(org?.status)) {
    logger.warn("[audiosocket] voz_org_suspensa — encerrando", { organization_id: callRow.organization_id });
    await encerrarSemAtender(callRow.id, END_REASON_ORG_PARADA);
    socket.end();
    return;
  }

  // SABOTAGEM: tirar o segundo argumento = o caso "agente do número" de fio-agente-do-numero fica vermelho.
  const agent = await getActiveVoiceAgent(
    callRow.organization_id,
    (callRow.ai_agent_id as string | null | undefined) ?? null,
  );
  if (!agent) {
    logger.error("[audiosocket] nenhum agente de voz ativo", { organization_id: callRow.organization_id });
    // SABOTAGEM: remover esta linha = o caso "sem agente" de fio-fim-da-ligacao fica vermelho.
    await encerrarSemAtender(callRow.id, END_REASON_SEM_AGENTE);
    socket.end();
    return;
  }

  // Mesmo acervo que o agente de texto (WhatsApp) já usa — reaproveita
  // resolverAcervoDoAgente/buscarConhecimento em vez de reimplementar RAG
  // pro canal de voz. NÃO aguardado aqui: dispara em paralelo com a abertura
  // do WebSocket da OpenAI dentro do bridge (linha abaixo) -- antes disto
  // rodava em série (aguardado ANTES de sequer abrir o WS), e a soma dos
  // dois round-trips era exatamente a demora sentida antes da IA "notar" que
  // o cliente já estava falando (ver AudioSocketCallContext.knowledgeSourceIdsPromise).
  const knowledgeSourceIdsPromise = resolverAcervoDoAgente(
    supabaseAdmin,
    callRow.organization_id,
    agent.id,
  ).catch((err) => {
    logger.error("[audiosocket] falha ao resolver acervo do agente de voz", {
      call_id: callRow.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return [] as string[];
  });

  // O `connected` é um claim: só vale sobre linha que ainda toca. Sem o filtro
  // de status, a recusa pela tela que chega entre a leitura acima e esta escrita
  // era sobrescrita, e a IA atendia a ligação recusada. Antes do bridge, para a
  // sessão paga nem abrir quando o claim perde.
  const answeredAt = new Date().toISOString();
  const { data: atendida, error: claimErr } = await supabaseAdmin
    .from("voice_calls")
    .update({ status: "connected", answered_at: answeredAt, handled_by: "ai", ai_agent_id: agent.id })
    .eq("id", callRow.id)
    .in("status", ["starting", "ringing"])
    .select("id");
  if (!atendida || atendida.length === 0) {
    if (claimErr) logger.error("[audiosocket] falha ao marcar chamada como atendida", { call_id: callRow.id, err: claimErr.message });
    else logger.info("[audiosocket] chamada deixou de tocar antes do atendimento — desligando", { call_id: callRow.id });
    socket.end();
    return;
  }

  const bridge = new AudioSocketCallBridge(socket, {
    callId: callRow.id,
    organizationId: callRow.organization_id,
    agentInstructions: agent.systemPrompt,
    voice: agent.voice,
    voiceSpeed: agent.voiceSpeed,
    voiceModel: agent.voiceModel,
    apiKey: agent.apiKey,
    onTranscriptTurn: (turn) => appendAudioSocketTranscriptTurn(uuid, turn),
    onCallEnded: () => finalizeAudioSocketCall(uuid),
    // Recebida: quem atende fala primeiro. Feita por nós: quem atende diz "alô".
    falaPrimeiro: callRow.direction === "inbound",
    ...(passagensPossiveis.has(callRow.id)
      ? {
          onPassarAoTime: async () => {
            const p = passagensPossiveis.get(callRow.id);
            if (!p) throw new Error("passagem esquecida");
            await setChannelVariable(p.canalNativo, "TRANSFERIR_PARA_TIME", "1");
          },
        }
      : {}),
    knowledgeSourceIdsPromise,
    searchKnowledge: async (pergunta: string) => {
      const knowledgeSourceIds = await knowledgeSourceIdsPromise;
      if (knowledgeSourceIds.length === 0) return { trechos: [] };
      const resultado = await buscarConhecimento(supabaseAdmin, {
        organizationId: callRow.organization_id,
        knowledgeSourceIds,
        pergunta,
        topK: agent.ragTopK,
        limiar: agent.ragSimilarityThreshold,
      });
      return { trechos: resultado.trechos };
    },
  });

  activeAudioSocketCalls.set(uuid, {
    bridge,
    callRowId: callRow.id,
    organizationId: callRow.organization_id,
    agentId: agent.id,
    contactId: (callRow.contact_id as string | null | undefined) ?? null,
    answeredAt,
    transcript: [],
    ligacao: {
      id: callRow.id,
      contact_id: (callRow.contact_id as string | null | undefined) ?? null,
      peer_phone: callRow.peer_phone as string,
      owner_user_id: (callRow.owner_user_id as string | null | undefined) ?? null,
      direction: callRow.direction as "inbound" | "outbound",
    },
  });

  // Se algum byte de áudio já chegou GRUDADO no mesmo pacote TCP do frame de
  // UUID (TCP é stream contínuo, não datagramas), reinjeta no socket depois
  // que o listener do bridge já está montado (constructor roda síncrono acima).
  if (leftover.length > 0) socket.emit("data", leftover);
}

function startAudioSocketServer() {
  const server = net.createServer((socket) => {
    let recvBuffer = Buffer.alloc(0);

    const onFirstData = (chunk: Buffer) => {
      recvBuffer = Buffer.concat([recvBuffer, chunk]);
      if (recvBuffer.length < 3) return;

      const type = recvBuffer[0] ?? 0;
      const len = recvBuffer.readUInt16BE(1);
      if (recvBuffer.length < 3 + len) return; // frame de UUID incompleto, espera mais

      socket.off("data", onFirstData);

      if (type !== 0x01) {
        logger.error("[audiosocket] primeiro frame não é UUID — fechando", { tipo: `0x${type.toString(16)}` });
        socket.end();
        return;
      }

      const uuid = bytesToUuid(recvBuffer.subarray(3, 3 + len));
      const leftover = recvBuffer.subarray(3 + len);
      void handleAudioSocketConnection(socket, uuid, leftover);
    };

    socket.on("data", onFirstData);
    socket.on("error", (err) => logger.error("[audiosocket] erro antes do UUID", { err: err.message }));
  });

  server.listen(AUDIOSOCKET_PORT, () => {
    logger.info(`[audiosocket] servidor TCP escutando na porta ${AUDIOSOCKET_PORT}`, { porta: AUDIOSOCKET_PORT });
  });
}

// ---------- bootstrap ----------

function assertEnv() {
  const required = ["ARI_URL", "ARI_WS_URL", "ARI_USERNAME", "ARI_PASSWORD", "OPENAI_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`[voice-agent] env faltando: ${missing.join(", ")}`);
  }
}

/**
 * Chamada de SAÍDA nunca passa pela Stasis (ver cabeçalho do arquivo) -- por
 * isso nenhum outro handler fecha o ciclo de vida dela. Sem isto, uma
 * ligação que toca e não é atendida (ou cai antes do AudioSocket conectar)
 * fica com status "ringing" pra sempre na tela, mesmo com o canal já tendo
 * sumido do Asterisk há muito tempo -- foi visto ao vivo assim.
 *
 * A RECEBIDA precisa do mesmo fechamento: ela só sai da Stasis de passagem, e
 * se o AudioSocket nunca conecta, nada mais a encerra. A linha dela não guarda
 * o channel.id nativo, e sim o UUID derivado dele -- por isso a busca é pelos
 * dois (idsDaLinhaDoCanal). Procurar só pelo channel.id deixava toda recebida
 * que caía antes da IA "tocando" para sempre (medido em 2026-11-04).
 *
 * Só mexe em linha ainda "ringing": se o AudioSocket já rodou,
 * finalizeAudioSocketCall() já marcou "ended" e este handler não deve
 * sobrescrever isso (ChannelDestroyed chega DEPOIS, no fim normal da
 * ligação, não é exclusivo de "nunca atendida").
 */
export async function handleChannelDestroyed(event: AriEvent) {
  const channelId = event.channel?.id;
  if (!channelId) return;

  const { data, error } = await supabaseAdmin
    .from("voice_calls")
    .update({ status: "ended", end_reason: "timeout", ended_at: new Date().toISOString() })
    .in("asterisk_channel_id", idsDaLinhaDoCanal(channelId))
    .eq("status", "ringing")
    .select(COLUNAS_DO_FIM)
    .maybeSingle();

  if (error) {
    logger.error("[voice-agent] falha ao marcar timeout pro canal", { channel_id: channelId, err: error.message });
    return;
  }
  const linha = data as LinhaDoFim | null;
  if (linha) {
    logger.info("[voice-agent] chamada marcada sem resposta", {
      call_id: linha.id,
      causa: event.cause_txt ?? null,
    });
    // A recebida que tocou e ninguém atendeu vira "Ligar de volta" na Central.
    // SABOTAGEM: remover esta chamada = o caso "timeout" de fio-fim-da-ligacao fica vermelho.
    await registrarFimDaLigacaoSip({ organizationId: linha.organization_id, ligacao: linha, endReason: "timeout" });
  }
}

/**
 * O canal de uma ligação em modo "IA, depois time humano" voltou à Stasis
 * porque a IA pediu a passagem (dialplan `[from-trunk-audiosocket]`, prioridade
 * `time`). Sem passagem registrada (worker reiniciado), desliga — o mesmo
 * desfecho de antes do dialplan saber passar.
 */
async function passarAoTime(canalNativo: string) {
  const entrada = [...passagensPossiveis.entries()].find(([, p]) => p.canalNativo === canalNativo);
  if (!entrada || !entrada[1].ligacao || !entrada[1].atendidaPelaIaEm) {
    logger.warn("[voice-agent] canal voltou para passar ao time sem passagem registrada — desligando", {
      canal: canalNativo,
    });
    await hangupChannel(canalNativo, "normal");
    return;
  }
  const [callId, p] = entrada;
  passagensPossiveis.delete(callId);
  const { data: linha } = await supabaseAdmin
    .from("voice_calls")
    .select("organization_id")
    .eq("id", callId)
    .maybeSingle();
  const organizationId = (linha as { organization_id?: string } | null)?.organization_id;
  if (!organizationId) {
    await hangupChannel(canalNativo, "normal");
    return;
  }
  await encaminharAoTime({
    canalDeQuemLigou: canalNativo,
    callId,
    organizationId,
    destino: p.destino,
    tronco: p.tronco,
    toqueSegundos: p.toqueSegundos,
    numeroDeQuemLigou: p.numeroDeQuemLigou,
    ligacao: p.ligacao!,
    handledBy: "ai_then_human",
    atendidaPelaIaEm: p.atendidaPelaIaEm,
  });
}

/**
 * Quem cuida de cada evento ARI. Exportada para o teste do fio: a perna do
 * time entra na app com `args = ["time", …]` e não pode cair no caminho da
 * ligação recebida; o canal que cai pode ser de um encaminhamento.
 */
export async function despacharEventoAri(event: AriEvent) {
  if (event.type === "StasisStart") {
    if (event.args?.[0] === "time") {
      if (event.channel?.id) await quandoOTimeAtende(event.channel.id);
      return;
    }
    if (event.args?.[0] === "transferir") {
      if (event.channel?.id) await passarAoTime(event.channel.id);
      return;
    }
    await handleStasisStart(event);
    return;
  }
  if (event.type === "ChannelDestroyed") {
    if (event.channel?.id && (await quandoUmCanalCai(event.channel.id))) return;
    await handleChannelDestroyed(event);
  }
}

function main() {
  assertEnv();
  logger.info("[voice-agent] worker iniciado, conectando ao ARI...");
  connectAriEvents(async (event) => {
    try {
      await despacharEventoAri(event);
    } catch (err) {
      logger.error("[voice-agent] erro processando evento ARI", {
        tipo: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
  startAudioSocketServer();
  iniciarAplicacaoDoTronco();
}

// O teste do fio importa `handleStasisStart` deste módulo: sem esta guarda,
// importar já ligava o worker (TCP + ARI + assertEnv) dentro do vitest.
// Produção não define nenhuma das três — comportamento idêntico ao de hoje.
if (!process.env.VITEST && !process.env.VITEST_WORKER_ID && process.env.NODE_ENV !== "test") {
  main();
}
