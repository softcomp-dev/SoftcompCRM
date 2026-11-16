/**
 * /api/v1/contacts/[id]/atendimentos — histórico de atendimento e registro de
 * interação. Banco em memória que aplica eq / in / lt, ordena e limita.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, `Nome de ${id}`]))),
}));

const { audit } = await import("@/lib/audit");
const { GET, POST } = await import("./route");

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const OUTRO_CONTATO = "22222222-2222-4222-8222-222222222223";
const LEAD = "33333333-3333-4333-8333-333333333333";
const LEAD_DE_OUTRO = "33333333-3333-4333-8333-333333333334";
const VENDEDOR = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

function banco(tabelas: Record<string, Linha[]>) {
  const from = (nome: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let operacao: "select" | "insert" = "select";
    let novo: Linha = {};
    let ordem: { coluna: string; asc: boolean } | null = null;
    let teto: number | null = null;
    const linhas = (tabelas[nome] ??= []);
    const executa = (): { data: Linha[] | null; error: null } => {
      if (operacao === "insert") {
        const linha = { id: `act-${linhas.length + 1}`, performed_at: "2026-11-16T12:00:00.000Z", created_at: "2026-11-16T12:00:00.000Z", ...novo };
        linhas.push(linha);
        return { data: [linha], error: null };
      }
      let r = linhas.filter((l) => filtros.every((f) => f(l)));
      if (ordem) {
        const { coluna, asc } = ordem;
        r = [...r].sort((a, b) => (String(a[coluna]) < String(b[coluna]) ? (asc ? -1 : 1) : asc ? 1 : -1));
      }
      if (teto !== null) r = r.slice(0, teto);
      return { data: r, error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      in: (c: string, v: unknown[]) => (filtros.push((l) => v.includes(l[c])), q),
      lt: (c: string, v: string) => (filtros.push((l) => String(l[c]) < v), q),
      order: (coluna: string, o: { ascending: boolean }) => ((ordem = { coluna, asc: o.ascending }), q),
      limit: (n: number) => ((teto = n), q),
      insert: (r: Linha) => ((operacao = "insert"), (novo = r), q),
      maybeSingle: async () => ({ data: executa().data?.[0] ?? null, error: null }),
      single: async () => ({ data: executa().data?.[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res(executa()),
    };
    return q;
  };
  return { from } as never;
}

let tabelas: Record<string, Linha[]>;

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    organizations: [{ id: ORG, timezone: "America/Sao_Paulo" }],
    contacts: [
      { id: CONTATO, organization_id: ORG, is_anonymized: false },
      { id: OUTRO_CONTATO, organization_id: ORG, is_anonymized: true },
    ],
    crm_leads: [
      { id: LEAD, organization_id: ORG, contact_id: CONTATO, title: "Reforma", status: "open", last_activity_at: null, created_at: "2026-11-01T00:00:00.000Z", crm_pipelines: { name: "Vendas" } },
      { id: LEAD_DE_OUTRO, organization_id: ORG, contact_id: OUTRO_CONTATO, title: "Outro", status: "open", last_activity_at: null, created_at: "2026-11-01T00:00:00.000Z", crm_pipelines: null },
    ],
    conversations: [{ id: "conv-1", organization_id: ORG, contact_id: CONTATO }],
    messages: [
      { id: "m1", organization_id: ORG, contact_id: CONTATO, conversation_id: "conv-1", direction: "inbound", sent_via: "crm", sent_by_user_id: null, type: "text", status: "received", sent_at: "2026-11-12T12:00:00.000Z" },
      { id: "m2", organization_id: ORG, contact_id: CONTATO, conversation_id: "conv-1", direction: "outbound", sent_via: "crm", sent_by_user_id: VENDEDOR, type: "text", status: "sent", sent_at: "2026-11-12T12:03:00.000Z" },
      // Mesma conversa e mesmo contato, mas de OUTRA organização: não pode aparecer.
      { id: "m3", organization_id: OUTRA_ORG, contact_id: CONTATO, conversation_id: "conv-1", direction: "inbound", sent_via: "crm", sent_by_user_id: null, type: "text", status: "received", sent_at: "2026-11-12T13:00:00.000Z" },
    ],
    voice_calls: [
      { id: "call-1", organization_id: ORG, contact_id: CONTATO, provider: "sip", direction: "outbound", status: "ended", started_at: "2026-11-11T14:00:00.000Z", answered_at: "2026-11-11T14:00:05.000Z", ended_at: "2026-11-11T14:10:05.000Z", duration_ms: 600000, owner_user_id: VENDEDOR, created_by: null, handled_by: "human", lead_id: LEAD },
    ],
    crm_lead_activities: [
      { id: "a1", organization_id: ORG, lead_id: LEAD, type: "interaction_logged", performed_at: "2026-11-10T15:00:00.000Z", performed_by_user_id: VENDEDOR, reason: "Reunião na obra", payload: { channel: "meeting", direction: "outbound", outcome: "talked" } },
      // Etapa mudou: é timeline, não atendimento.
      { id: "a2", organization_id: ORG, lead_id: LEAD, type: "stage_changed", performed_at: "2026-11-10T16:00:00.000Z", performed_by_user_id: VENDEDOR, reason: "Movido", payload: {} },
    ],
  };
  vi.mocked(createClient).mockResolvedValue(banco(tabelas));
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: VENDEDOR, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as never);
});

const ctx = (id = CONTATO) => ({ params: Promise.resolve({ id }) });

function post(body: unknown, id = CONTATO) {
  return new NextRequest(`http://localhost/api/v1/contacts/${id}/atendimentos`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const registro = {
  lead_id: LEAD,
  channel: "phone",
  direction: "outbound",
  outcome: "talked",
  summary: "Liguei do celular e combinamos a visita",
  duration_minutes: 12,
};

describe("GET — o histórico", () => {
  it("junta chat, ligação e registro, mais recente primeiro, com o nome de quem participou", async () => {
    const res = await GET(new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/atendimentos`), ctx());
    expect(res.status).toBe(200);
    const { data, meta } = (await res.json()) as {
      data: { items: Array<Record<string, unknown>>; leads: Array<Record<string, unknown>> };
      meta: { has_more: boolean };
    };
    expect(data.items.map((i) => i.source)).toEqual(["chat", "call", "record"]);
    // O chat da outra organização não entrou na contagem.
    expect(data.items[0]!.messages).toEqual({ from_contact: 1, from_team: 1, from_ai: 0, automated: 0 });
    expect(data.items[0]!.team).toEqual([{ user_id: VENDEDOR, name: `Nome de ${VENDEDOR}` }]);
    expect(data.items[2]!.summary).toBe("Reunião na obra");
    expect(data.items.some((i) => i.activity_type === "stage_changed")).toBe(false);
    expect(data.leads).toEqual([
      expect.objectContaining({ id: LEAD, title: "Reforma", pipeline_name: "Vendas" }),
    ]);
    expect(meta.has_more).toBe(false);
  });

  it("contato de outra organização é 404", async () => {
    tabelas.contacts![0]!.organization_id = OUTRA_ORG;
    const res = await GET(new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/atendimentos`), ctx());
    expect(res.status).toBe(404);
  });

  it("cursor estragado é 400", async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/atendimentos?cursor=nao-e-cursor`),
      ctx(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST — registrar interação", () => {
  it("grava a atividade no negócio, com o texto em reason e o tipo pelo desfecho", async () => {
    const res = await POST(post(registro), ctx());
    expect(res.status).toBe(201);
    const gravada = tabelas.crm_lead_activities!.at(-1)!;
    expect(gravada).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      contact_id: CONTATO,
      type: "interaction_logged",
      source_module: "atendimento",
      actor_kind: "user",
      performed_by_user_id: VENDEDOR,
      reason: registro.summary,
      payload: { channel: "phone", direction: "outbound", outcome: "talked", duration_minutes: 12 },
    });
    // A auditoria leva a forma do contato, nunca o texto.
    const chamadaDoAudit = vi.mocked(audit).mock.calls[0]![0];
    expect(JSON.stringify(chamadaDoAudit)).not.toContain(registro.summary);
  });

  it("tentativa sem resposta grava o outro tipo, e a data informada vira o momento da atividade", async () => {
    const res = await POST(
      post({ ...registro, outcome: "no_answer", occurred_at: "2026-11-15T13:00:00.000Z" }),
      ctx(),
    );
    expect(res.status).toBe(201);
    expect(tabelas.crm_lead_activities!.at(-1)).toMatchObject({
      type: "interaction_attempted",
      performed_at: "2026-11-15T13:00:00.000Z",
    });
  });

  it("negócio de outro contato é 422, e nada é gravado", async () => {
    const antes = tabelas.crm_lead_activities!.length;
    const res = await POST(post({ ...registro, lead_id: LEAD_DE_OUTRO }), ctx());
    expect(res.status).toBe(422);
    expect(tabelas.crm_lead_activities).toHaveLength(antes);
  });

  it("contato anonimizado não recebe registro", async () => {
    const res = await POST(post({ ...registro, lead_id: LEAD_DE_OUTRO }), ctx(OUTRO_CONTATO));
    expect(res.status).toBe(409);
  });

  it("corpo inválido é 422 com o campo que falhou", async () => {
    const res = await POST(post({ ...registro, summary: "" }), ctx());
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(Object.keys(corpo.error.details)).toContain("summary");
  });

  it("quem não pode escrever recebe a resposta do requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await POST(post(registro), ctx());
    expect(res.status).toBe(403);
  });
});
