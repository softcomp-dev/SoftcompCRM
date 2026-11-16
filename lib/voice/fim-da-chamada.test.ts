import { describe, expect, it, vi } from "vitest";

import { desfechoDaLigacao, registrarFimDaLigacao } from "./fim-da-chamada";

vi.mock("@/lib/leads/agent-activity", () => ({
  emitAgentActivityForContact: vi.fn(async () => ({ routed: true, leadId: "lead-1" })),
}));

import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";

const RECEBIDA_PERDIDA = { answered_at: null, direction: "inbound" as const };
const RECEBIDA_ATENDIDA = { answered_at: "2026-11-16T10:00:00Z", direction: "inbound" as const };
const FEITA_SEM_RESPOSTA = { answered_at: null, direction: "outbound" as const };

describe("desfechoDaLigacao", () => {
  it("recebida e perdida avisa e carimba como perdida", () => {
    expect(desfechoDaLigacao(RECEBIDA_PERDIDA, false)).toMatchObject({
      abreAviso: true,
      carimbaLinhaDoTempo: true,
      tipoNaLinhaDoTempo: "voice_call_missed",
    });
  });

  it("recebida perdida de bloqueado não avisa nem carimba", () => {
    expect(desfechoDaLigacao(RECEBIDA_PERDIDA, true)).toMatchObject({
      abreAviso: false,
      carimbaLinhaDoTempo: false,
    });
  });

  it("atendida de bloqueado aconteceu: carimba, sem aviso", () => {
    expect(desfechoDaLigacao(RECEBIDA_ATENDIDA, true)).toMatchObject({
      abreAviso: false,
      carimbaLinhaDoTempo: true,
      tipoNaLinhaDoTempo: "voice_call",
    });
  });

  it("a IA atendeu, a pessoa pediu o time e ninguém pegou: avisa", () => {
    expect(desfechoDaLigacao(RECEBIDA_ATENDIDA, false, { timeNaoAtendeu: true })).toMatchObject({
      abreAviso: true,
      tipoNaLinhaDoTempo: "voice_call",
    });
    expect(desfechoDaLigacao(RECEBIDA_ATENDIDA, true, { timeNaoAtendeu: true }).abreAviso).toBe(false);
  });

  it("feita sem resposta não pede para ligar de volta", () => {
    expect(desfechoDaLigacao(FEITA_SEM_RESPOSTA, false)).toMatchObject({
      abreAviso: false,
      tipoNaLinhaDoTempo: "voice_call_unanswered",
    });
  });
});

describe("registrarFimDaLigacao", () => {
  function poolFalso(bloqueado: boolean) {
    const consultas: { sql: string; params: unknown[] }[] = [];
    return {
      consultas,
      pool: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          consultas.push({ sql, params });
          if (sql.includes("from contacts")) return { rows: [{ is_blocked: bloqueado }] };
          return { rows: [] };
        }),
      } as never,
    };
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  it("perdida: aviso, evento done e linha do tempo assinada pelo agente", async () => {
    const { pool, consultas } = poolFalso(false);
    await registrarFimDaLigacao(
      pool,
      {
        organizationId: "org-1",
        ligacao: { id: "call-1", contact_id: "c-1", peer_phone: "+5511", owner_user_id: null, ...RECEBIDA_PERDIDA },
        endReason: "no_agent",
        motivoLegivel: "Nenhum agente de voz estava ativo.",
        agentId: "ag-1",
      },
      log,
    );
    expect(consultas.some((c) => c.sql.includes("'voice_call_missed'"))).toBe(true);
    const evento = consultas.find((c) => c.sql.includes("insert into event_log"));
    expect(JSON.parse(evento!.params[2] as string)).toEqual({ end_reason: "no_agent", answered: false });
    expect(emitAgentActivityForContact).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice_call_missed", agentId: "ag-1", usuarioId: null }),
    );
  });

  it("sem contato: avisa sem referência e não carimba linha do tempo", async () => {
    vi.mocked(emitAgentActivityForContact).mockClear();
    const { pool, consultas } = poolFalso(false);
    await registrarFimDaLigacao(
      pool,
      {
        organizationId: "org-1",
        ligacao: { id: "call-2", contact_id: null, peer_phone: "+5511", owner_user_id: null, ...RECEBIDA_PERDIDA },
        endReason: "timeout",
        motivoLegivel: "O telefone tocou e ninguém atendeu.",
      },
      log,
    );
    const aviso = consultas.find((c) => c.sql.includes("agent_inbox_items"));
    expect(aviso!.params[3]).toBeNull();
    expect(emitAgentActivityForContact).not.toHaveBeenCalled();
  });
});
