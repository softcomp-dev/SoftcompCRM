/**
 * TESTE DO FIO: a ligação de um tronco de DID único é da organização DONA do
 * tronco por onde chegou.
 *
 * Tronco de DID único manda a extensão "s" (sem o número discado). Antes, o
 * worker só aceitava isso com UM número ativo na instalação inteira — duas
 * empresas na mesma VPS, cada uma com seu tronco, e toda ligação recebida era
 * recusada como ambígua. O dialplan agora passa o endpoint
 * (`Stasis(voice-agent,inbound,${CHANNEL(endpoint)})`), e o tronco da tela tem
 * a organização no nome.
 *
 * SABOTAGEM: remover o filtro `organization_id` em `resolveInboundNumber` =
 * o caso "duas empresas" fica vermelho (recusa como ambígua).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const fakes = vi.hoisted(() => ({
  numeros: [] as Array<Record<string, unknown>>,
  inseridas: [] as Array<Record<string, unknown>>,
  ari: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const consulta = {
        select: () => consulta,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return consulta;
        },
        limit: async () => ({
          data: fakes.numeros.filter((n) => filtros.every(([c, v]) => n[c] === v)).slice(0, 2),
          error: null,
        }),
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (l: Record<string, unknown>) => {
          fakes.inseridas.push(l);
          const r = { data: { id: "chamada-1", ...l }, error: null };
          return { select: () => ({ single: async () => r }) };
        },
      };
      void tabela;
      return consulta;
    },
    rpc: () => ({ single: async () => ({ data: null, error: null }) }),
  }),
}));
vi.mock("@/lib/voip/ariClient", () => {
  const gravar = (nome: string) => async (...a: unknown[]) => {
    fakes.ari.push([nome, ...a]);
  };
  return {
    connectAriEvents: () => ({ parar: () => {} }),
    hangupChannel: gravar("hangup"),
    setChannelVariable: gravar("setVar"),
    continueDialplan: gravar("continue"),
  };
});
vi.mock("./fim-sip", () => ({ registrarFimDaLigacaoSip: async () => undefined }));
vi.mock("./aplicar-tronco", () => ({ iniciarAplicacaoDoTronco: () => ({ parar: () => {} }) }));
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

import { handleStasisStart } from "./index";

function numero(org: string) {
  return {
    organization_id: org,
    is_active: true,
    routing_mode: "ai",
    default_ai_agent_id: null,
    fallback_user_id: null,
    forward_to_phone: null,
    forward_ring_seconds: 25,
    trunk_endpoint: "PJSIP/trunk-endpoint",
  };
}

function ligacao(endpoint: string | undefined) {
  return handleStasisStart({
    type: "StasisStart",
    args: endpoint === undefined ? ["inbound"] : ["inbound", endpoint],
    channel: { id: "1789081888.20", dialplan: { exten: "s" }, caller: { number: "27999990000" } },
  } as never);
}

beforeEach(() => {
  fakes.numeros = [numero(ORG_A), numero(ORG_B)];
  fakes.inseridas = [];
  fakes.ari = [];
});

describe("tronco de DID único com várias empresas", () => {
  it("duas empresas: a ligação é da dona do tronco por onde chegou", async () => {
    await ligacao(`org-${ORG_B}-trunk-endpoint`);
    expect(fakes.inseridas[0]).toMatchObject({ organization_id: ORG_B, status: "ringing" });
    expect(fakes.ari.filter((c) => c[0] === "continue")).toHaveLength(1);
  });

  it("sem tronco da tela (endpoint antigo), duas empresas seguem ambíguas: recusa", async () => {
    await ligacao("trunk-endpoint");
    expect(fakes.inseridas).toHaveLength(0);
    expect(fakes.ari.filter((c) => c[0] === "hangup")).toHaveLength(1);
  });

  it("uma empresa só, sem tronco da tela: como antes, atende", async () => {
    fakes.numeros = [numero(ORG_A)];
    await ligacao(undefined);
    expect(fakes.inseridas[0]).toMatchObject({ organization_id: ORG_A });
  });
});
