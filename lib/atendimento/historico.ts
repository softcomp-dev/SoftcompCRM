/**
 * O HISTÓRICO DE ATENDIMENTO — toda interação da equipe com o cliente, numa
 * lista só: o chat, as ligações e o que o vendedor registrou à mão.
 *
 * ── Calculado, não copiado (DIRC) ───────────────────────────────────────────
 * Nada aqui é gravado de novo. O chat sai de `messages`, a ligação de
 * `voice_calls` (VoIP e WhatsApp), o registro manual de `crm_lead_activities`
 * (`lib/atendimento/interacao-manual.ts`). Uma tabela "de atendimentos" que
 * espelhasse as três seria a segunda fonte da mesma história, e divergiria na
 * primeira mensagem apagada pela LGPD.
 *
 * ── O que é UM atendimento de chat ──────────────────────────────────────────
 * As mensagens de UMA conversa num mesmo DIA, no fuso da organização. Mensagem
 * por mensagem seria a própria conversa, não um histórico; a conversa inteira
 * numa linha só esconderia que o cliente voltou três vezes no mês. O dia é a
 * unidade que quem vende usa ("falei com ele na terça").
 *
 * ── A página termina sempre numa virada de dia ──────────────────────────────
 * Cada fonte é lida com teto. Se um dia ficasse partido entre duas páginas, o
 * chat daquele dia apareceria duas vezes, cada uma com metade das mensagens.
 * Então a página só leva dias INTEIROS: o dia que pode estar incompleto (o do
 * primeiro item que não coube, ou o da linha mais antiga de uma fonte que bateu
 * no teto) fica para a próxima, e o cursor é o fim desse dia.
 *
 * Funções puras: quem consulta o banco é a rota
 * `app/api/v1/contacts/[id]/atendimentos/route.ts`.
 */
import { diaLocalISO, instanteDe } from "@/lib/agenda/fuso";
import type { CanalDeRegistro, Desfecho, Direcao } from "@/lib/atendimento/interacao-manual";
import {
  CANAIS_DE_REGISTRO,
  DESFECHOS,
  DIRECOES,
  TIPO_INTERACAO_REGISTRADA,
  TIPO_TENTATIVA_REGISTRADA,
} from "@/lib/atendimento/interacao-manual";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

/** De onde o item veio. */
export type OrigemDoAtendimento = "chat" | "call" | "record";

/** Por onde aconteceu. `voip` e `whatsapp_call` são ligações feitas pelo CRM. */
export type CanalDoHistorico = "whatsapp_chat" | "voip" | "whatsapp_call" | CanalDeRegistro;

export interface ContagemDeMensagens {
  from_contact: number;
  from_team: number;
  from_ai: number;
  automated: number;
}

export interface ItemDoHistorico {
  /** Estável entre páginas: `chat:<conversa>:<dia>`, `call:<id>`, `record:<id>`. */
  id: string;
  source: OrigemDoAtendimento;
  channel: CanalDoHistorico;
  direction: Direcao | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  /** `null` quando não se aplica (chat) ou ainda não se sabe (ligação em curso). */
  outcome: Desfecho | null;
  /** Texto que uma pessoa escreveu. Só o registro manual tem. */
  summary: string | null;
  lead_id: string | null;
  conversation_id: string | null;
  /** O tipo da atividade, para o registro. Os outros não têm. */
  activity_type: string | null;
  /** A ligação foi atendida pelo agente de IA. */
  handled_by_ai: boolean;
  /** Quem da equipe participou. Nomes são resolvidos na rota. */
  team_user_ids: string[];
  messages: ContagemDeMensagens | null;
}

/** O item como a rota o devolve: com o nome de quem participou. */
export interface ItemDoHistoricoView extends Omit<ItemDoHistorico, "team_user_ids"> {
  team: { user_id: string; name: string | null }[];
}

// ─── As linhas como o banco as entrega ──────────────────────────────────────

export interface MensagemBruta {
  id: string;
  conversation_id: string;
  direction: string;
  sent_via: string;
  sent_by_user_id: string | null;
  type: string;
  status: string;
  sent_at: string;
}

export interface ChamadaBruta {
  id: string;
  provider: string | null;
  direction: string;
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  owner_user_id: string | null;
  created_by: string | null;
  handled_by: string | null;
  lead_id: string | null;
}

export interface AtividadeBruta {
  id: string;
  type: string;
  lead_id: string | null;
  performed_at: string;
  performed_by_user_id: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * Os tipos de atividade que SÃO interação com o cliente contada por uma pessoa.
 * `cold_call_result` entra porque é o vendedor dizendo o que aconteceu na
 * ligação; `voice_call*` não entra porque a ligação já vem de `voice_calls`, com
 * duração e desfecho, e contar as duas seria a mesma ligação duas vezes.
 */
export const TIPOS_DE_REGISTRO = [
  TIPO_INTERACAO_REGISTRADA,
  TIPO_TENTATIVA_REGISTRADA,
  "cold_call_result",
] as const satisfies readonly ActivityType[];

/** Mensagem que não é fala de ninguém: reação, aviso do sistema, envio que falhou. */
function contaComoFala(m: MensagemBruta): boolean {
  return m.type !== "reaction" && m.type !== "system" && m.status !== "failed";
}

/** De quem é a fala, pela coluna `sent_via` (CHECK em `messages`). */
function ladoDaFala(m: MensagemBruta): keyof ContagemDeMensagens {
  if (m.direction === "inbound") return "from_contact";
  if (m.sent_via === "ai") return "from_ai";
  if (m.sent_via === "automation" || m.sent_via === "system") return "automated";
  // crm, user e external_device: uma pessoa da equipe, pelo CRM ou pelo celular.
  return "from_team";
}

function direcaoValida(v: unknown): Direcao | null {
  return (DIRECOES as readonly string[]).includes(v as string) ? (v as Direcao) : null;
}

export function agruparChats(mensagens: MensagemBruta[], fuso: string): ItemDoHistorico[] {
  const grupos = new Map<string, MensagemBruta[]>();
  for (const m of mensagens) {
    if (!contaComoFala(m)) continue;
    const chave = `${m.conversation_id}:${diaLocalISO(new Date(m.sent_at), fuso)}`;
    const lista = grupos.get(chave);
    if (lista) lista.push(m);
    else grupos.set(chave, [m]);
  }

  const itens: ItemDoHistorico[] = [];
  for (const [chave, lista] of grupos) {
    lista.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
    const contagem: ContagemDeMensagens = { from_contact: 0, from_team: 0, from_ai: 0, automated: 0 };
    const equipe = new Set<string>();
    for (const m of lista) {
      const lado = ladoDaFala(m);
      contagem[lado] += 1;
      if (lado === "from_team" && m.sent_by_user_id) equipe.add(m.sent_by_user_id);
    }
    const primeira = lista[0]!;
    const ultima = lista[lista.length - 1]!;
    itens.push({
      id: `chat:${chave}`,
      source: "chat",
      channel: "whatsapp_chat",
      direction: direcaoValida(primeira.direction),
      started_at: primeira.sent_at,
      ended_at: ultima.sent_at,
      duration_seconds: null,
      outcome: null,
      summary: null,
      lead_id: null,
      conversation_id: primeira.conversation_id,
      activity_type: null,
      handled_by_ai: contagem.from_ai > 0,
      team_user_ids: [...equipe],
      messages: contagem,
    });
  }
  return itens;
}

export function daChamada(c: ChamadaBruta): ItemDoHistorico {
  const encerrada = c.status === "ended";
  let duracao: number | null = c.duration_ms !== null ? Math.round(c.duration_ms / 1000) : null;
  if (duracao === null && c.answered_at && c.ended_at) {
    duracao = Math.max(0, Math.round((Date.parse(c.ended_at) - Date.parse(c.answered_at)) / 1000));
  }
  const quem = c.owner_user_id ?? c.created_by;
  return {
    id: `call:${c.id}`,
    source: "call",
    channel: c.provider === "sip" ? "voip" : "whatsapp_call",
    direction: direcaoValida(c.direction),
    started_at: c.started_at,
    ended_at: c.ended_at,
    duration_seconds: duracao,
    // Atendida é conversa; encerrada sem atender é tentativa; o resto ainda está tocando.
    outcome: c.answered_at ? "talked" : encerrada ? "no_answer" : null,
    summary: null,
    lead_id: c.lead_id,
    conversation_id: null,
    activity_type: null,
    handled_by_ai: c.handled_by === "ai" || c.handled_by === "ai_then_human",
    team_user_ids: quem ? [quem] : [],
    messages: null,
  };
}

/** `null` para atividade que não é registro de interação — a rota já filtra, isto é a segunda trava. */
export function doRegistro(a: AtividadeBruta): ItemDoHistorico | null {
  if (!(TIPOS_DE_REGISTRO as readonly string[]).includes(a.type)) return null;
  const p = a.payload ?? {};
  const ehColdCall = a.type === "cold_call_result";

  const canal = (CANAIS_DE_REGISTRO as readonly string[]).includes(p.channel as string)
    ? (p.channel as CanalDeRegistro)
    : ehColdCall
      ? "phone"
      : "other";
  const desfecho = (DESFECHOS as readonly string[]).includes(p.outcome as string)
    ? (p.outcome as Desfecho)
    : a.type === TIPO_TENTATIVA_REGISTRADA
      ? "no_answer"
      : a.type === TIPO_INTERACAO_REGISTRADA
        ? "talked"
        : null;
  const minutos = typeof p.duration_minutes === "number" ? p.duration_minutes : null;

  return {
    id: `record:${a.id}`,
    source: "record",
    channel: canal,
    direction: direcaoValida(p.direction) ?? (ehColdCall ? "outbound" : null),
    started_at: a.performed_at,
    ended_at: null,
    duration_seconds: minutos !== null ? minutos * 60 : null,
    outcome: desfecho,
    summary: a.reason,
    lead_id: a.lead_id,
    conversation_id: null,
    activity_type: a.type,
    handled_by_ai: false,
    team_user_ids: a.performed_by_user_id ? [a.performed_by_user_id] : [],
    messages: null,
  };
}

function maisRecentePrimeiro(a: ItemDoHistorico, b: ItemDoHistorico): number {
  if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** O instante em que começa o dia SEGUINTE a `dia` (YYYY-MM-DD), no fuso. */
function fimDoDia(dia: string, fuso: string): string {
  const [ano = 0, mes = 1, d = 1] = dia.split("-").map(Number);
  const seguinte = new Date(Date.UTC(ano, mes - 1, d + 1));
  return instanteDe(
    { ano: seguinte.getUTCFullYear(), mes: seguinte.getUTCMonth() + 1, dia: seguinte.getUTCDate(), hora: 0 },
    fuso,
  ).toISOString();
}

function inicioDoDia(dia: string, fuso: string): string {
  const [ano = 0, mes = 1, d = 1] = dia.split("-").map(Number);
  return instanteDe({ ano, mes, dia: d, hora: 0 }, fuso).toISOString();
}

export interface FonteLida<T> {
  linhas: T[];
  /** A leitura devolveu o teto: pode haver mais linhas antes da mais antiga. */
  noTeto: boolean;
}

export interface EntradaDaPagina {
  fuso: string;
  limite: number;
  mensagens: FonteLida<MensagemBruta>;
  chamadas: FonteLida<ChamadaBruta>;
  registros: FonteLida<AtividadeBruta>;
}

export interface PaginaDoHistorico {
  itens: ItemDoHistorico[];
  /** Instante para o próximo pedido (`antes`), ou `null` quando acabou. */
  proximoAntes: string | null;
}

function maisAntigo(instantes: string[]): string | null {
  let menor: string | null = null;
  for (const i of instantes) if (menor === null || i < menor) menor = i;
  return menor;
}

export function montarPagina(entrada: EntradaDaPagina): PaginaDoHistorico {
  const { fuso, limite } = entrada;
  const dia = (instante: string) => diaLocalISO(new Date(instante), fuso);

  const itens = [
    ...agruparChats(entrada.mensagens.linhas, fuso),
    ...entrada.chamadas.linhas.map(daChamada),
    ...entrada.registros.linhas.map(doRegistro).filter((i): i is ItemDoHistorico => i !== null),
  ].sort(maisRecentePrimeiro);

  // Os dias que podem estar incompletos nesta leitura.
  const suspeitos: string[] = [];
  if (itens.length > limite) suspeitos.push(dia(itens[limite]!.started_at));
  const instantesNoTeto: string[][] = [];
  if (entrada.mensagens.noTeto) instantesNoTeto.push(entrada.mensagens.linhas.map((m) => m.sent_at));
  if (entrada.chamadas.noTeto) instantesNoTeto.push(entrada.chamadas.linhas.map((c) => c.started_at));
  if (entrada.registros.noTeto) instantesNoTeto.push(entrada.registros.linhas.map((r) => r.performed_at));
  for (const instantes of instantesNoTeto) {
    const antiga = maisAntigo(instantes);
    if (antiga) suspeitos.push(dia(antiga));
  }

  if (suspeitos.length === 0) return { itens, proximoAntes: null };

  // O mais RECENTE dos dias suspeitos: dali para trás nada é garantido inteiro.
  const corte = suspeitos.reduce((a, b) => (a > b ? a : b));
  const inteiros = itens.filter((i) => dia(i.started_at) > corte);
  if (inteiros.length > 0) return { itens: inteiros, proximoAntes: fimDoDia(corte, fuso) };

  // A página inteira é um dia só, e ele não coube. Entrega o dia como veio (o
  // teto das fontes é largo para isso ser raro) e anda para o dia anterior —
  // devolver vazio com o mesmo cursor pediria a mesma página para sempre.
  return { itens: itens.filter((i) => dia(i.started_at) === corte), proximoAntes: inicioDoDia(corte, fuso) };
}
