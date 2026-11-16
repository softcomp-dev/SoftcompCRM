import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { encerraDemanda } from "@/lib/leads/encerramento";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/consolidado/servidor", () => ({ abrirVisaoConsolidada: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: vi.fn() }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));
vi.mock("@/app/api/v1/pipelines/_handler", () => ({
  listPipelinesHandler: vi.fn(async (_sb: unknown, ctx: { organization_id: string }) => ({
    pipelines: ctx.organization_id === ORG_B ? [{ id: FUNIL_B, name: "Vendas B" }] : [],
  })),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: vi.fn(async () => null),
}));
vi.mock("@/lib/contacts/conflito-unico", () => ({
  encontrarContatoPorEmail: vi.fn(async () => null),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: vi.fn(async () => ({ lead: { id: LEAD, status: "lost" }, jaEstava: false })),
}));
vi.mock("@/lib/leads/campos-exigidos", () => ({
  settingsDoFunil: vi.fn(async () => ({})),
  validaCamposExigidos: vi.fn(() => ({ faltando: [] })),
  recusaDeCamposObrigatorios: vi.fn(),
}));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const FUNIL_A = "55555555-5555-4555-8555-555555555555";
const FUNIL_B = "66666666-6666-4666-8666-666666666666";
const ETAPA_B = "77777777-7777-4777-8777-777777777777";
const PERDA_A = "88888888-8888-4888-8888-888888888888";
const CONTATO_A = "99999999-9999-4999-8999-999999999999";

type Row = Record<string, unknown>;

/** Banco falso: select/eq/in/order/limit + maybeSingle e update com filtros. */
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filtros: [string, unknown][] = [];
      let patch: Row | null = null;
      const linhas = () =>
        (tables[table] ?? []).filter((r) => filtros.every(([c, v]) => r[c] === v));
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => (filtros.push([c, v]), b),
        in: () => b,
        order: () => b,
        limit: () => b,
        update: (v: Row) => ((patch = v), b),
        maybeSingle: async () => {
          const row = linhas()[0] ?? null;
          if (row && patch) Object.assign(row, patch);
          return { data: row, error: null };
        },
        then: async (resolve: (v: unknown) => unknown) => resolve({ data: linhas(), error: null }),
      };
      return b;
    },
  };
}

let db: ReturnType<typeof fakeDb>;
let tabelas: { crm_leads: Row[]; crm_pipelines: Row[]; crm_stages: Row[]; contacts: Row[] };

function semear(papelNaOrigem: "manager" | "agent" = "manager") {
  tabelas = {
    crm_leads: [
      {
        id: LEAD,
        organization_id: ORG_A,
        pipeline_id: FUNIL_A,
        status: "open",
        title: "Pedido 42",
        contact_id: CONTATO_A,
        owner_agent_id: "agente-a",
        source_metadata: {},
        custom_fields: {},
      },
    ],
    crm_pipelines: [{ id: FUNIL_B, organization_id: ORG_B, name: "Vendas B" }],
    crm_stages: [
      { id: ETAPA_B, organization_id: ORG_B, pipeline_id: FUNIL_B, position: 1, is_won: false, is_lost: false, is_archived: false },
      { id: PERDA_A, organization_id: ORG_A, pipeline_id: FUNIL_A, position: 9, is_won: false, is_lost: true, is_archived: false },
    ],
    contacts: [
      { id: CONTATO_A, organization_id: ORG_A, name: "Maria", phone_number: "+5511999998888" },
    ],
  };
  db = fakeDb(tabelas);
  vi.mocked(abrirVisaoConsolidada).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" } as never,
    supabase: db as never,
    vinculos: [
      { organization_id: ORG_A, nome: "Matriz", role: papelNaOrigem },
      { organization_id: ORG_B, nome: "Filial", role: "agent" },
    ],
    escopo: [],
    t: (s: string) => s,
  });
}

function post(body: unknown) {
  return new NextRequest(`http://x/api/v1/leads/${LEAD}/transferir-empresa`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: LEAD }) };

beforeEach(() => {
  vi.clearAllMocks();
  semear();
  vi.mocked(requireRole).mockResolvedValue({ ok: true } as never);
  vi.mocked(createLeadHandler).mockResolvedValue({
    id: "novo-lead",
    pipeline_id: FUNIL_B,
    stage_id: ETAPA_B,
  } as never);
  vi.mocked(createContactHandler).mockResolvedValue({
    contact: { id: "contato-b" },
    action: "created",
  } as never);
});

describe("POST /api/v1/leads/[id]/transferir-empresa", () => {
  it("cria contato e negócio no destino, encerra a origem e audita nos dois lados", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ organization_id: ORG_B, pipeline_id: FUNIL_B }), params);
    expect(res.status).toBe(201);

    // O papel é conferido em CADA empresa, do banco.
    expect(vi.mocked(requireRole).mock.calls.map((c) => [c[0], c[1]?.organizationId])).toEqual([
      ["manager", ORG_A],
      ["agent", ORG_B],
    ]);

    const [, ctxContato, ficha] = vi.mocked(createContactHandler).mock.calls[0]!;
    expect(ctxContato.organization_id).toBe(ORG_B);
    expect(ficha).toMatchObject({ name: "Maria", phone_number: "+5511999998888" });

    const [, ctxLead, payload] = vi.mocked(createLeadHandler).mock.calls[0]!;
    expect(ctxLead.organization_id).toBe(ORG_B);
    expect(payload).toMatchObject({ pipeline_id: FUNIL_B, stage_id: ETAPA_B, contact_id: "contato-b" });
    expect(payload).not.toHaveProperty("owner_agent_id");

    expect(vi.mocked(emitLeadActivity).mock.calls[0]![1]).toMatchObject({
      organizationId: ORG_B,
      leadId: "novo-lead",
      type: "transferred_from_organization",
      reason: "Veio da empresa Matriz",
    });

    const [, ctxEncerra, encerra] = vi.mocked(encerraDemanda).mock.calls[0]!;
    expect(ctxEncerra.organization_id).toBe(ORG_A);
    expect(encerra).toMatchObject({
      leadId: LEAD,
      desfecho: "lost",
      motivo: "moved_to_another_pipeline",
      razaoNaTimeline: "Transferido para a empresa Filial",
    });

    expect(tabelas.crm_leads[0]!.source_metadata).toMatchObject({
      transferido_para: { organization_id: ORG_B, lead_id: "novo-lead" },
    });

    expect(vi.mocked(audit).mock.calls.map((c) => [c[0].action, c[0].organizationId])).toEqual([
      ["lead.transferred_to_organization", ORG_A],
      ["lead.received_from_organization", ORG_B],
    ]);
  });

  it("reaproveita o contato que o destino já tem com o mesmo telefone", async () => {
    vi.mocked(encontrarContatoPorTelefone).mockResolvedValueOnce({
      id: "ja-existe-em-b",
      phone_number: "+5511999998888",
    });
    const { POST } = await import("./route");
    const res = await POST(post({ organization_id: ORG_B, pipeline_id: FUNIL_B }), params);
    expect(res.status).toBe(201);
    expect(vi.mocked(encontrarContatoPorTelefone).mock.calls[0]![1]).toBe(ORG_B);
    expect(createContactHandler).not.toHaveBeenCalled();
    expect(vi.mocked(createLeadHandler).mock.calls[0]![2]).toMatchObject({ contact_id: "ja-existe-em-b" });
  });

  it("recusa quem é só atendente na origem, sem escrever nada", async () => {
    semear("agent");
    const { POST } = await import("./route");
    const res = await POST(post({ organization_id: ORG_B, pipeline_id: FUNIL_B }), params);
    expect(res.status).toBe(403);
    expect(createLeadHandler).not.toHaveBeenCalled();
    expect(encerraDemanda).not.toHaveBeenCalled();
  });

  it("recusa funil que não é da empresa de destino", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ organization_id: ORG_B, pipeline_id: FUNIL_A }), params);
    expect(res.status).toBe(404);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("recusa a própria empresa como destino", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ organization_id: ORG_A, pipeline_id: FUNIL_A }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("transfer_same_organization");
  });

  it("recusa a origem sem etapa de perda antes de criar qualquer coisa no destino", async () => {
    tabelas.crm_stages = tabelas.crm_stages.filter((s) => s.id !== PERDA_A);
    const { POST } = await import("./route");
    const res = await POST(post({ organization_id: ORG_B, pipeline_id: FUNIL_B }), params);
    expect(res.status).toBe(422);
    expect(createContactHandler).not.toHaveBeenCalled();
    expect(createLeadHandler).not.toHaveBeenCalled();
  });

  it("negócio de empresa em que a pessoa não tem vínculo é 404", async () => {
    tabelas.crm_leads[0]!.organization_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const { POST } = await import("./route");
    const res = await POST(post({ organization_id: ORG_B, pipeline_id: FUNIL_B }), params);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/leads/[id]/transferir-empresa", () => {
  it("lista só as outras empresas, com funis e etapas", async () => {
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://x"), params);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.empresas).toHaveLength(1);
    expect(data.empresas[0]).toMatchObject({
      organization_id: ORG_B,
      name: "Filial",
      pipelines: [{ id: FUNIL_B, name: "Vendas B", stages: [{ id: ETAPA_B }] }],
    });
  });
});
