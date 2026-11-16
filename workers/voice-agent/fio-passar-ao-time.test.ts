/**
 * TESTE DO FIO: no modo "IA, depois time humano", a IA passa a ligação ao time.
 *
 * O caminho inteiro pelo worker real, com ARI gravador, tabela em memória e a
 * ponte de voz como dublê (sem OpenAI):
 *
 *   1. a recebida vai ao AudioSocket (a IA atende) e a ponte ganha
 *      `onPassarAoTime` — só porque o número tem telefone do time;
 *   2. a IA pede a passagem → o canal nativo é marcado TRANSFERIR_PARA_TIME=1;
 *   3. a sessão de IA acaba, a LIGAÇÃO não: a linha segue `connected`,
 *      `handled_by = ai_then_human`, sem rastro de fim;
 *   4. o canal volta à Stasis (`transferir`) → a perna do time é originada;
 *   5. o time não atende → `human_no_answer` COM aviso, mesmo a IA tendo atendido.
 *
 * SABOTAGEM: trocar a condição `passagem && call.bridge.pediuOTime()` em
 * `finalizeAudioSocketCall` por `false` = o caso principal fica vermelho.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const fakes = vi.hoisted(() => ({
  tabela: [] as Array<Record<string, unknown>>,
  ari: [] as Array<[string, ...unknown[]]>,
  fins: [] as Array<Record<string, unknown>>,
  roteamento: {} as Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  pediuOTime: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const filtros: Array<(l: Linha) => boolean> = [];
      let mudanca: Linha | null = null;
      const alvo = () => (tabela === "voice_calls" ? fakes.tabela.filter((l) => filtros.every((f) => f(l))) : []);
      const aplicar = () => {
        const linhas = alvo();
        if (mudanca) for (const l of linhas) Object.assign(l, mudanca);
        return linhas;
      };
      const consulta = {
        insert: (l: Linha) => {
          const gravada = { id: `chamada-${fakes.tabela.length + 1}`, ...l };
          fakes.tabela.push(gravada);
          return { select: () => ({ single: async () => ({ data: gravada, error: null }) }) };
        },
        select: () => consulta,
        update: (m: Linha) => {
          mudanca = m;
          return consulta;
        },
        eq: (c: string, v: unknown) => {
          filtros.push((l) => l[c] === v);
          return consulta;
        },
        neq: (c: string, v: unknown) => {
          filtros.push((l) => l[c] !== v);
          return consulta;
        },
        in: (c: string, vs: unknown[]) => {
          filtros.push((l) => vs.includes(l[c]));
          return consulta;
        },
        single: async () => {
          const l = aplicar()[0];
          return l ? { data: l, error: null } : { data: null, error: { message: "nada" } };
        },
        maybeSingle: async () => {
          if (tabela === "organizations") return { data: { status: "active" }, error: null };
          return { data: aplicar()[0] ?? null, error: null };
        },
        then: (ok: (r: unknown) => unknown) => Promise.resolve({ data: aplicar(), error: null }).then(ok),
      };
      return consulta;
    },
    rpc: () => ({ single: async () => ({ data: fakes.roteamento, error: null }) }),
  }),
}));

vi.mock("@/lib/voip/ariClient", () => {
  const gravar =
    (nome: string, devolve: unknown = undefined) =>
    async (...args: unknown[]) => {
      fakes.ari.push([nome, ...args]);
      return devolve;
    };
  return {
    connectAriEvents: () => undefined,
    hangupChannel: gravar("hangup"),
    setChannelVariable: gravar("setVar"),
    continueDialplan: gravar("continue"),
    answerChannel: gravar("answer"),
    originarParaOTime: gravar("originarParaOTime"),
    tocarParaQuemEspera: gravar("tocar"),
    pararDeTocar: gravar("pararDeTocar"),
    criarPonte: gravar("criarPonte", { id: "ponte-1" }),
    porNaPonte: gravar("porNaPonte"),
    desfazerPonte: gravar("desfazerPonte"),
  };
});
vi.mock("./fim-sip", () => ({
  registrarFimDaLigacaoSip: async (p: Record<string, unknown>) => {
    fakes.fins.push(p);
  },
}));
vi.mock("./audioSocketBridge", () => ({
  AudioSocketCallBridge: class {
    constructor(_socket: unknown, ctx: Record<string, unknown>) {
      fakes.ctx = ctx;
    }
    pediuOTime() {
      return fakes.pediuOTime;
    }
    usoDaSessao() {
      return { modelo: "gpt-realtime", uso: { respostas: 0 }, erro: null };
    }
  },
}));
vi.mock("@/lib/voip/resolve-caller", () => ({
  resolveOrCreateCallerContact: async () => ({ id: "contato-1", is_blocked: false, is_personal: false }),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: async () => ({ criado: false, motivo: "ja_existe" }),
}));
vi.mock("@/lib/ai/agents", () => ({
  getActiveVoiceAgent: async () => ({ id: "agente-1", systemPrompt: "", voice: "alloy", apiKey: "k" }),
}));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({ registrarChamadaDeIa: async () => undefined }));

import { _limparEncaminhamentos } from "./encaminhar-ao-time";
import { despacharEventoAri, handleAudioSocketConnection } from "./index";

const CANAL = "1789081888.11";

function chamadas(nome: string) {
  return fakes.ari.filter((c) => c[0] === nome);
}

async function ligacaoAtendidaPelaIa() {
  await despacharEventoAri({
    type: "StasisStart",
    channel: { id: CANAL, dialplan: { exten: "552731912377" }, caller: { number: "27999990000" } },
  } as never);
  const uuid = fakes.tabela[0]!.asterisk_channel_id as string;
  const socket = new EventEmitter() as EventEmitter & { end: () => void };
  socket.end = vi.fn();
  await handleAudioSocketConnection(socket as never, uuid, Buffer.alloc(0));
}

beforeEach(() => {
  fakes.tabela = [];
  fakes.ari = [];
  fakes.fins = [];
  fakes.ctx = null;
  fakes.pediuOTime = false;
  fakes.roteamento = {
    organization_id: "org-1",
    routing_mode: "ai_then_human",
    default_ai_agent_id: null,
    fallback_user_id: null,
    forward_to_phone: "+5527988887777",
    forward_ring_seconds: 15,
    trunk_endpoint: "PJSIP/trunk-endpoint",
  };
  _limparEncaminhamentos();
});

describe("IA, depois time humano", () => {
  it("a IA passa ao time: marca o canal, mantém a ligação e encaminha quando o canal volta", async () => {
    await ligacaoAtendidaPelaIa();
    expect(chamadas("continue")).toHaveLength(1);
    expect(typeof fakes.ctx!.onPassarAoTime).toBe("function");

    await (fakes.ctx!.onPassarAoTime as () => Promise<void>)();
    expect(chamadas("setVar")).toContainEqual(["setVar", CANAL, "TRANSFERIR_PARA_TIME", "1"]);

    fakes.pediuOTime = true;
    await (fakes.ctx!.onCallEnded as () => Promise<void>)();
    expect(fakes.tabela[0]).toMatchObject({ status: "connected", handled_by: "ai_then_human" });
    expect(fakes.fins).toHaveLength(0);

    await despacharEventoAri({ type: "StasisStart", channel: { id: CANAL }, args: ["transferir"] } as never);
    expect(chamadas("originarParaOTime")).toHaveLength(1);
    expect(chamadas("originarParaOTime")[0]![1]).toMatchObject({
      endpoint: "PJSIP/5527988887777@trunk-endpoint",
      timeout: 15,
    });

    // O time não atende: encerra com aviso, mesmo a IA tendo atendido antes.
    const time = (chamadas("originarParaOTime")[0]![1] as { channelId: string }).channelId;
    await despacharEventoAri({ type: "ChannelDestroyed", channel: { id: time } } as never);
    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "human_no_answer" });
    expect(fakes.fins).toEqual([expect.objectContaining({ endReason: "human_no_answer", timeNaoAtendeu: true })]);
  });

  it("o time atende na passagem: não atende de novo a perna de quem ligou", async () => {
    await ligacaoAtendidaPelaIa();
    fakes.pediuOTime = true;
    await (fakes.ctx!.onCallEnded as () => Promise<void>)();
    await despacharEventoAri({ type: "StasisStart", channel: { id: CANAL }, args: ["transferir"] } as never);
    const time = (chamadas("originarParaOTime")[0]![1] as { channelId: string }).channelId;
    await despacharEventoAri({ type: "StasisStart", channel: { id: time }, args: ["time", "chamada-1"] } as never);

    expect(chamadas("answer")).toHaveLength(0);
    expect(chamadas("porNaPonte")).toEqual([["porNaPonte", "ponte-1", [CANAL, time]]]);
  });

  it("a IA encerra sem passar: fim normal, com rastro", async () => {
    await ligacaoAtendidaPelaIa();
    await (fakes.ctx!.onCallEnded as () => Promise<void>)();
    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "user_ended" });
    expect(fakes.fins).toHaveLength(1);
  });

  it("sem telefone do time, a ponte não recebe como passar", async () => {
    fakes.roteamento.forward_to_phone = null;
    await ligacaoAtendidaPelaIa();
    expect(fakes.ctx!.onPassarAoTime).toBeUndefined();
  });

  it("canal que volta para passar sem passagem registrada é desligado", async () => {
    await despacharEventoAri({ type: "StasisStart", channel: { id: "outro.1" }, args: ["transferir"] } as never);
    expect(chamadas("hangup")).toEqual([["hangup", "outro.1", "normal"]]);
    expect(chamadas("originarParaOTime")).toHaveLength(0);
  });
});
