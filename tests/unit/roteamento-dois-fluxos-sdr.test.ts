/**
 * OS DOIS FLUXOS DE DISTRIBUIÇÃO DE LEAD NOVO (docs/features/sdr.md).
 *
 * O worker de roteamento inteiro, contra um banco em memória que APLICA os
 * filtros: uma conversa nova, dois atendentes livres (Ana e Bia), rodízio.
 *
 *   - empresa SEM função SDR → o lead vai para a equipe, como sempre;
 *   - empresa COM SDR ativo  → o lead vai só para o SDR;
 *   - SDR ativo, mas ocupado → o lead ESPERA (reenfileira), não vaza à equipe;
 *   - função ligada sem ninguém marcado → equipe (não para a entrada).
 *
 * Quem recebeu é lido do `p_user` do claim (`fn_channel_routing_claim`), o
 * mesmo ponto onde o banco grava o dono da conversa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));

const admin = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin() }));

import { runRoutingWorker } from "@/lib/routing/worker";

const ORG = "org-1";
const CONVERSA = "11111111-1111-4111-8111-111111111111";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;
interface Estado {
  settings: Linha;
  membros: Linha[];
  disponibilidade: Linha[];
  /** conversas abertas já atribuídas (carga) */
  abertas: Linha[];
  claims: string[];
  fechamento: Linha | null;
  requeue: Linha | null;
}

function dublarAdmin(e: Estado) {
  function responder(t: string, op: string, dados: Linha | undefined, f: Array<[string, string, unknown]>) {
    const casa = (l: Linha) =>
      f.every(([tipo, c, v]) =>
        tipo === "eq" ? c.includes(".") || l[c] === v
        : tipo === "is" ? (l[c] ?? null) === v
        : tipo === "in" ? (v as unknown[]).includes(l[c])
        : tipo === "not" ? (l[c] ?? null) !== null
        : true,
      );
    if (t === "event_log") {
      if (op === "update") {
        if (dados?.status === "processing") {
          return {
            data: {
              id: "e1",
              updated_at: "2026-11-10T12:00:00Z",
              payload: { organization_id: ORG, conversation_id: CONVERSA },
              metadata: {},
            },
            error: null,
          };
        }
        if (dados?.status === "done") e.fechamento = dados;
        if (dados?.status === "pending") e.requeue = dados;
        return { data: null, error: null };
      }
      const presos = f.some(([, c, v]) => c === "status" && v === "processing");
      return { data: presos ? [] : [{ id: "e1", organization_id: ORG, consumed_by: [], attempts: 0 }], error: null };
    }
    if (t === "conversations" && f.some(([, c]) => c === "id")) {
      return {
        data: {
          id: CONVERSA, organization_id: ORG, contact_id: "contato-1", channel_session_id: null,
          assigned_to_user_id: null, status: "open", metadata: {}, last_inbound_at: null, sector_id: null,
        },
        error: null,
      };
    }
    if (t === "conversations") return { data: e.abertas.filter(casa), error: null };
    if (t === "organizations") return { data: { settings: e.settings }, error: null };
    if (t === "user_organizations") return { data: e.membros.filter(casa), error: null };
    if (t === "attendant_availability") return { data: e.disponibilidade.filter(casa), error: null };
    if (t === "conversation_assignment_events") return { data: [], error: null };
    if (t === "crm_leads") return { data: [], error: null };
    return { data: null, error: null }; // contacts, agent_cases
  }

  function cadeia(t: string) {
    let op = "select";
    let dados: Linha | undefined;
    const f: Array<[string, string, unknown]> = [];
    const self: Record<string, unknown> = {
      select: () => self,
      update: (d: Linha) => ((op = "update"), (dados = d), self),
      eq: (c: string, v: unknown) => (f.push(["eq", c, v]), self),
      is: (c: string, v: unknown) => (f.push(["is", c, v]), self),
      in: (c: string, v: unknown) => (f.push(["in", c, v]), self),
      not: (c: string) => (f.push(["not", c, null]), self),
      lte: () => self, or: () => self, order: () => self, limit: () => self,
      maybeSingle: () => self, single: () => self,
      then: (res: (r: unknown) => void) => res(responder(t, op, dados, f)),
    };
    return self;
  }

  return {
    from: (t: string) => cadeia(t),
    rpc: async (nome: string, args: Linha) => {
      if (nome === "fn_channel_routing_claim") {
        e.claims.push(args.p_user as string);
        return { data: "assigned", error: null };
      }
      return { data: null, error: null };
    },
  };
}

const membro = (user_id: string, extra: Linha = {}) => ({
  organization_id: ORG, user_id, role: "agent", revoked_at: null, sdr_since: null, ...extra,
});
const livre = (user_id: string) => ({ organization_id: ORG, user_id, capacity: 5, schedule: {}, is_available: true });

let estado: Estado;
beforeEach(() => {
  admin.mockReset();
  estado = {
    settings: { routing: { mode: "round_robin" } },
    membros: [membro(ANA), membro(BIA)],
    disponibilidade: [livre(ANA), livre(BIA)],
    abertas: [],
    claims: [],
    fechamento: null,
    requeue: null,
  };
  admin.mockImplementation(() => dublarAdmin(estado));
});

async function rodar() {
  await runRoutingWorker({ now: new Date("2026-11-10T15:00:00Z") });
}

describe("os dois fluxos de distribuição de lead novo", () => {
  it("empresa sem função SDR: a equipe recebe, como sempre", async () => {
    estado.membros = [membro(ANA), membro(BIA, { sdr_since: "2026-11-01T00:00:00Z" })];
    // Ana com menos atribuições recentes — sem recorte, o rodízio pode escolhê-la
    await rodar();
    expect(estado.claims).toHaveLength(1);
    expect([ANA, BIA]).toContain(estado.claims[0]);
    expect((estado.fechamento?.metadata as Linha).distribuicao).toBe("equipe");
  });

  it("empresa com SDR ativo: só o SDR recebe", async () => {
    estado.settings = { ...estado.settings, sdr: { enabled: true } };
    estado.membros = [membro(ANA), membro(BIA, { sdr_since: "2026-11-01T00:00:00Z" })];
    await rodar();
    expect(estado.claims).toEqual([BIA]);
    expect((estado.fechamento?.metadata as Linha).distribuicao).toBe("sdr");
  });

  it("SDR ativo mas sem folga: o lead espera um SDR, não vai para a equipe", async () => {
    estado.settings = { ...estado.settings, sdr: { enabled: true } };
    estado.membros = [membro(ANA), membro(BIA, { sdr_since: "2026-11-01T00:00:00Z" })];
    estado.disponibilidade = [livre(ANA), { ...livre(BIA), capacity: 1 }];
    estado.abertas = [{ organization_id: ORG, assigned_to_user_id: BIA, status: "open" }];
    await rodar();
    expect(estado.claims).toEqual([]);
    expect((estado.requeue?.metadata as { last_requeue: Linha }).last_requeue).toMatchObject({
      reason: "no_eligible",
      distribuicao: "sdr",
    });
  });

  it("função ligada sem ninguém marcado: a equipe recebe (a entrada não para)", async () => {
    estado.settings = { ...estado.settings, sdr: { enabled: true } };
    await rodar();
    expect(estado.claims).toHaveLength(1);
    expect((estado.fechamento?.metadata as Linha).distribuicao).toBe("equipe");
  });

  it("SDR rebaixado a Somente leitura não conta: a equipe recebe", async () => {
    estado.settings = { ...estado.settings, sdr: { enabled: true } };
    estado.membros = [membro(ANA), membro(BIA, { role: "viewer", sdr_since: "2026-11-01T00:00:00Z" })];
    await rodar();
    expect(estado.claims).toEqual([ANA]);
  });
});
