import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";

import { criarBanco, type BancoEmMemoria } from "../../_banco-em-memoria";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  audit: vi.fn(),
  emitLeadActivity: vi.fn(),
  aplicarEfeitosDaDecisao: vi.fn(),
  banco: null as unknown as { client: unknown },
}));

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: mocks.emitLeadActivity }));
vi.mock("@/lib/propostas/efeitos-da-decisao", () => ({ aplicarEfeitosDaDecisao: mocks.aplicarEfeitosDaDecisao }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.banco.client }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const LEAD_ID = "77777777-7777-4777-8777-777777777777";
const CONTACT_ID = "88888888-8888-4888-8888-888888888888";
const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_DE_OUTRA_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let banco: BancoEmMemoria;

function montar(opts: { proposta?: string; documento?: "quote" | "order" | null; itens?: [string, string] } = {}) {
  banco = criarBanco();
  mocks.banco = banco;
  const [a, b] = opts.itens ?? ["pendente", "pendente"];
  banco.tabelas.crm_proposals = [
    {
      id: PROPOSAL_ID, organization_id: ORG_ID, status: opts.proposta ?? "enviada",
      lead_id: LEAD_ID, contact_id: CONTACT_ID, retorno_id: null, total_cents: 2000,
    },
  ];
  banco.tabelas.crm_leads = [
    {
      id: LEAD_ID, organization_id: ORG_ID, value_cents: 2000,
      sales_document_kind: opts.documento === undefined ? "quote" : opts.documento,
    },
  ];
  banco.tabelas.crm_proposal_items = [
    { id: ITEM_A, organization_id: ORG_ID, proposal_id: PROPOSAL_ID, descricao: "1020 REDONDO", status: a,
      quantidade: 1, preco_unitario_cents: 1200, desconto_cents: 0 },
    { id: ITEM_B, organization_id: ORG_ID, proposal_id: PROPOSAL_ID, descricao: "1045 REDONDO", status: b,
      quantidade: 1, preco_unitario_cents: 800, desconto_cents: 0 },
    // Mesma proposta referida, outra organização: nunca pode ser alcançado.
    { id: ITEM_DE_OUTRA_ORG, organization_id: OUTRA_ORG, proposal_id: PROPOSAL_ID, descricao: "alheio",
      status: "pendente", quantidade: 1, preco_unitario_cents: 1, desconto_cents: 0 },
  ];
}

const item = (id: string) => banco.tabelas.crm_proposal_items!.find((l) => l.id === id)!;
const proposta = () => banco.tabelas.crm_proposals![0]!;
const lead = () => banco.tabelas.crm_leads![0]!;

async function patch(itens: unknown) {
  const { PATCH } = await import("./route");
  return PATCH(
    new NextRequest(`http://localhost/api/v1/proposals/${PROPOSAL_ID}/itens`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itens }),
    }),
    { params: Promise.resolve({ id: PROPOSAL_ID }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireRole.mockResolvedValue({ ok: true, user: { id: USER_ID, idioma: "pt-BR" }, org: { orgId: ORG_ID } });
  mocks.requireSupportWrite.mockResolvedValue(null);
  mocks.audit.mockResolvedValue(undefined);
  mocks.emitLeadActivity.mockResolvedValue({ ok: true });
  mocks.aplicarEfeitosDaDecisao.mockResolvedValue(undefined);
});

describe("PATCH /api/v1/proposals/[id]/itens — cotação", () => {
  it("aceitar um item com outro pendente: grava o item, a proposta segue enviada", async () => {
    montar();
    const res = await patch([{ id: ITEM_A, status: "aceito" }]);
    expect(res.status).toBe(200);
    expect(item(ITEM_A).status).toBe("aceito");
    expect(item(ITEM_A).status_changed_at).toBeTruthy();
    expect(item(ITEM_B).status).toBe("pendente");
    expect(proposta().status).toBe("enviada");
    expect(mocks.aplicarEfeitosDaDecisao).not.toHaveBeenCalled();
    expect(mocks.emitLeadActivity).toHaveBeenCalledWith(
      banco.client,
      expect.objectContaining({ type: "proposal_item_status_changed", reason: "1020 REDONDO: Aceito" }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.item_status_changed" }));
  });

  it("aceite parcial: o último item decidido aceita a proposta e o negócio passa a valer só o aceito", async () => {
    montar({ itens: ["aceito", "pendente"] });
    const res = await patch([{ id: ITEM_B, status: "recusado" }]);
    expect(res.status).toBe(200);
    expect(proposta().status).toBe("aceita");
    expect(proposta().decided_by_user_id).toBe(USER_ID);
    expect(mocks.aplicarEfeitosDaDecisao).toHaveBeenCalledWith(expect.objectContaining({ decisao: "aceita" }));
    expect(lead().value_cents).toBe(1200);
    const body = await res.json();
    expect(body.data.status).toBe("aceita");
  });

  it("todos recusados: a proposta é recusada e o valor do negócio não muda", async () => {
    montar();
    const res = await patch([
      { id: ITEM_A, status: "recusado" },
      { id: ITEM_B, status: "recusado" },
    ]);
    expect(res.status).toBe(200);
    expect(proposta().status).toBe("recusada");
    expect(mocks.aplicarEfeitosDaDecisao).toHaveBeenCalledWith(expect.objectContaining({ decisao: "recusada" }));
    expect(lead().value_cents).toBe(2000);
  });

  it("produção não existe na cotação: 422 e nada muda", async () => {
    montar();
    const res = await patch([{ id: ITEM_A, status: "em_producao" }]);
    expect(res.status).toBe(422);
    expect(item(ITEM_A).status).toBe("pendente");
  });

  it("item de outra organização não é alcançado: 422 nomeando o item, nada muda", async () => {
    montar();
    const res = await patch([{ id: ITEM_DE_OUTRA_ORG, status: "aceito" }]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.details.itens).toEqual([ITEM_DE_OUTRA_ORG]);
    expect(item(ITEM_DE_OUTRA_ORG).status).toBe("pendente");
  });
});

describe("PATCH /api/v1/proposals/[id]/itens — pedido", () => {
  it("proposta aceita num negócio de pedido: o item aceito vai para produção, a proposta não muda", async () => {
    montar({ proposta: "aceita", documento: "order", itens: ["aceito", "recusado"] });
    const res = await patch([{ id: ITEM_A, status: "em_producao" }]);
    expect(res.status).toBe(200);
    expect(item(ITEM_A).status).toBe("em_producao");
    expect(proposta().status).toBe("aceita");
    expect(mocks.aplicarEfeitosDaDecisao).not.toHaveBeenCalled();
  });

  it("o item recusado não entra no pedido", async () => {
    montar({ proposta: "aceita", documento: "order", itens: ["aceito", "recusado"] });
    const res = await patch([{ id: ITEM_B, status: "em_producao" }]);
    expect(res.status).toBe(422);
    expect(item(ITEM_B).status).toBe("recusado");
  });

  it("proposta aceita num negócio que ainda é cotação: 409, produção só depois de virar pedido", async () => {
    montar({ proposta: "aceita", documento: "quote", itens: ["aceito", "aceito"] });
    const res = await patch([{ id: ITEM_A, status: "em_producao" }]);
    expect(res.status).toBe(409);
    expect(item(ITEM_A).status).toBe("aceito");
  });
});

describe("PATCH /api/v1/proposals/[id]/itens — portas", () => {
  it("proposta em rascunho: 409", async () => {
    montar({ proposta: "rascunho" });
    const res = await patch([{ id: ITEM_A, status: "aceito" }]);
    expect(res.status).toBe(409);
  });

  it("proposta de outra organização: 404", async () => {
    montar();
    proposta().organization_id = OUTRA_ORG;
    const res = await patch([{ id: ITEM_A, status: "aceito" }]);
    expect(res.status).toBe(404);
  });

  it("status fora do vocabulário: 422", async () => {
    montar();
    const res = await patch([{ id: ITEM_A, status: "faturado" }]);
    expect(res.status).toBe(422);
  });

  it("respeita a recusa de suporte antes de qualquer efeito", async () => {
    montar();
    mocks.requireSupportWrite.mockResolvedValueOnce(fail("forbidden", "Somente leitura", 403));
    const res = await patch([{ id: ITEM_A, status: "aceito" }]);
    expect(res.status).toBe(403);
    expect(item(ITEM_A).status).toBe("pendente");
  });
});
