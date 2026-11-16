/**
 * TESTE DO FIO: o modo "Time humano" encaminha a ligação ao telefone do time.
 *
 * `routing_mode` existia desde a 0347 e era ignorado: toda ligação ia para a
 * IA. Aqui os eventos ARI passam pelo despachante real (`despacharEventoAri`)
 * contra uma tabela em memória que aplica os filtros do código, e o ARI é um
 * gravador de chamadas. Os desfechos medidos:
 *
 *   - a recebida em modo humano NÃO vai ao AudioSocket: origina a perna do time
 *     pelo tronco, com o tempo de toque do número;
 *   - o time atende → as duas pernas entram numa ponte e a linha vira `connected`;
 *   - o time não atende → a linha encerra `human_no_answer`, com aviso, e quem
 *     ligou é desligado;
 *   - número em modo humano sem telefone do time → encerra `human_unavailable`;
 *   - quem ligou desiste enquanto o time toca → a perna do time é desligada.
 *
 * SABOTAGEM: remover o bloco `routing.routing_mode === "human"` de
 * `handleStasisStart` = o primeiro caso fica vermelho (a ligação vai à IA).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const fakes = vi.hoisted(() => ({
  tabela: [] as Array<Record<string, unknown>>,
  ari: [] as Array<[string, ...unknown[]]>,
  fins: [] as Array<Record<string, unknown>>,
  roteamento: {} as Record<string, unknown>,
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
        maybeSingle: async () => ({ data: aplicar()[0] ?? null, error: null }),
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
vi.mock("@/lib/voip/resolve-caller", () => ({
  resolveOrCreateCallerContact: async () => ({ id: "contato-1", is_blocked: false, is_personal: false }),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: async () => ({ criado: false, motivo: "ja_existe" }),
}));
vi.mock("@/lib/ai/agents", () => ({ getActiveVoiceAgent: async () => null }));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));

import { _limparEncaminhamentos } from "./encaminhar-ao-time";
import { despacharEventoAri } from "./index";

const CANAL_DE_QUEM_LIGOU = "1789081888.9";

function chegaLigacao() {
  return despacharEventoAri({
    type: "StasisStart",
    channel: { id: CANAL_DE_QUEM_LIGOU, dialplan: { exten: "552731912377" }, caller: { number: "27999990000" } },
  } as never);
}

function chamadasAri(nome: string) {
  return fakes.ari.filter((c) => c[0] === nome);
}

function canalDoTime(): string {
  const originar = chamadasAri("originarParaOTime")[0];
  return (originar![1] as { channelId: string }).channelId;
}

beforeEach(() => {
  fakes.tabela = [];
  fakes.ari = [];
  fakes.fins = [];
  fakes.roteamento = {
    organization_id: "org-1",
    routing_mode: "human",
    default_ai_agent_id: null,
    fallback_user_id: null,
    forward_to_phone: "+5527988887777",
    forward_ring_seconds: 20,
    trunk_endpoint: "PJSIP/trunk-endpoint",
  };
  _limparEncaminhamentos();
});

describe("modo Time humano", () => {
  it("time humano: a ligação vai ao telefone do time, não à IA", async () => {
    await chegaLigacao();

    expect(chamadasAri("continue")).toHaveLength(0);
    expect(chamadasAri("originarParaOTime")).toHaveLength(1);
    expect(chamadasAri("originarParaOTime")[0]![1]).toMatchObject({
      endpoint: "PJSIP/5527988887777@trunk-endpoint",
      timeout: 20,
      callerId: "27999990000",
      originator: CANAL_DE_QUEM_LIGOU,
    });
    expect(fakes.tabela[0]).toMatchObject({ status: "ringing", handled_by: "human" });
  });

  it("o time atende: as duas pernas entram na ponte e a linha vira connected", async () => {
    await chegaLigacao();
    const time = canalDoTime();
    await despacharEventoAri({ type: "StasisStart", channel: { id: time }, args: ["time", "chamada-1"] } as never);

    expect(chamadasAri("answer")).toEqual([["answer", CANAL_DE_QUEM_LIGOU]]);
    expect(chamadasAri("porNaPonte")).toEqual([["porNaPonte", "ponte-1", [CANAL_DE_QUEM_LIGOU, time]]]);
    expect(fakes.tabela[0]).toMatchObject({ status: "connected" });
    expect(typeof fakes.tabela[0]!.answered_at).toBe("string");

    // O time desliga depois de falar: fim normal, sem aviso.
    await despacharEventoAri({ type: "ChannelDestroyed", channel: { id: time } } as never);
    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "user_ended" });
    expect(fakes.fins).toEqual([expect.objectContaining({ endReason: "user_ended", timeNaoAtendeu: false })]);
    expect(chamadasAri("hangup").map((c) => c[1])).toContain(CANAL_DE_QUEM_LIGOU);
  });

  it("o time não atende: encerra human_no_answer, avisa e desliga quem ligou", async () => {
    await chegaLigacao();
    await despacharEventoAri({ type: "ChannelDestroyed", channel: { id: canalDoTime() } } as never);

    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "human_no_answer" });
    expect(fakes.fins).toEqual([expect.objectContaining({ endReason: "human_no_answer", timeNaoAtendeu: true })]);
    expect(chamadasAri("hangup").map((c) => c[1])).toContain(CANAL_DE_QUEM_LIGOU);
  });

  it("sem telefone do time: encerra human_unavailable e desliga", async () => {
    fakes.roteamento.forward_to_phone = null;
    await chegaLigacao();

    expect(chamadasAri("originarParaOTime")).toHaveLength(0);
    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "human_unavailable" });
    expect(chamadasAri("hangup").map((c) => c[1])).toEqual([CANAL_DE_QUEM_LIGOU]);
  });

  it("quem ligou desiste enquanto o time toca: a perna do time é desligada", async () => {
    await chegaLigacao();
    const time = canalDoTime();
    await despacharEventoAri({ type: "ChannelDestroyed", channel: { id: CANAL_DE_QUEM_LIGOU } } as never);

    expect(chamadasAri("hangup").map((c) => c[1])).toContain(time);
    // A linha ainda tocava: o handler genérico a fecha como perdida.
    expect(fakes.tabela[0]).toMatchObject({ status: "ended", end_reason: "timeout" });
  });

  it("modo IA continua indo ao AudioSocket", async () => {
    fakes.roteamento.routing_mode = "ai";
    await chegaLigacao();
    expect(chamadasAri("continue")).toHaveLength(1);
    expect(chamadasAri("originarParaOTime")).toHaveLength(0);
  });
});
