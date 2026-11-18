import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBanco, type BancoEmMemoria } from "@/app/api/v1/proposals/_banco-em-memoria";

import type { McpContext } from "../types";
import { crmGetProposalItems, crmUpdateProposalItemsStatus } from "./itens-da-proposta";

const mocks = vi.hoisted(() => ({ capacidades: vi.fn(), audit: vi.fn(), emitLeadActivity: vi.fn(), efeitos: vi.fn() }));
vi.mock("@/lib/organizacao/capacidades", () => ({ capacidadesDaOrganizacao: mocks.capacidades }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: mocks.emitLeadActivity }));
vi.mock("@/lib/propostas/efeitos-da-decisao", () => ({ aplicarEfeitosDaDecisao: mocks.efeitos }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "12121212-1212-4121-8121-121212121212";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const OUTRO_CONTATO = "23232323-2323-4232-8232-232323232323";
const LEAD = "33333333-3333-4333-8333-333333333333";
const OUTRO_LEAD = "34343434-3434-4343-8343-343434343434";
const PROPOSTA_V1 = "44444444-4444-4444-8444-444444444444";
const PROPOSTA_V2 = "45454545-4545-4545-8545-454545454545";
const ITEM_A = "55555555-5555-4555-8555-555555555555";
const ITEM_B = "56565656-5656-4565-8565-565656565656";

let banco: BancoEmMemoria;

function ctx(over: Partial<McpContext> = {}): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", role: "ai_operator", agent_id: "agente-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: banco.client as never,
    ...over,
  } as McpContext;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capacidades.mockResolvedValue(["propostas"]);
  mocks.emitLeadActivity.mockResolvedValue({ ok: true });
  banco = criarBanco();
  banco.tabelas.crm_leads = [
    { id: LEAD, organization_id: ORG, contact_id: CONTATO, value_cents: 2000, sales_document_kind: "quote" },
    { id: OUTRO_LEAD, organization_id: ORG, contact_id: OUTRO_CONTATO, value_cents: 0, sales_document_kind: null },
  ];
  banco.tabelas.crm_proposals = [
    // A v1 foi substituída pela v2: a vigente é a v2.
    { id: PROPOSTA_V1, organization_id: ORG, lead_id: LEAD, contact_id: CONTATO, status: "substituida", numero: 7, ano: 2026, versao: 1, total_cents: 2000, moeda: "BRL", retorno_id: null, created_at: "2026-11-01T00:00:00Z" },
    { id: PROPOSTA_V2, organization_id: ORG, lead_id: LEAD, contact_id: CONTATO, status: "enviada", numero: 7, ano: 2026, versao: 2, total_cents: 2000, moeda: "BRL", retorno_id: null, created_at: "2026-11-10T00:00:00Z" },
  ];
  banco.tabelas.crm_proposal_items = [
    { id: ITEM_A, organization_id: ORG, proposal_id: PROPOSTA_V2, descricao: "1020 REDONDO", quantidade: 4, preco_unitario_cents: 300, desconto_cents: 0, status: "pendente", position: 1 },
    { id: ITEM_B, organization_id: ORG, proposal_id: PROPOSTA_V2, descricao: "1045 REDONDO", quantidade: 1, preco_unitario_cents: 800, desconto_cents: 0, status: "pendente", position: 2 },
  ];
});

describe("crm_get_proposal_items", () => {
  it("pelo negócio, devolve a proposta vigente (pula a substituída) com a fase e o total de cada item", async () => {
    const r = (await crmGetProposalItems.handler({ lead_id: LEAD }, ctx())) as {
      proposta: { id: string; numero: string; fase_dos_itens: string };
      itens: Array<{ descricao: string; total_cents: number; status: string; status_rotulo: string }>;
    };
    expect(r.proposta.id).toBe(PROPOSTA_V2);
    expect(r.proposta.numero).toBe("0007/2026");
    expect(r.proposta.fase_dos_itens).toBe("cotacao");
    expect(r.itens.map((i) => [i.descricao, i.total_cents, i.status_rotulo])).toEqual([
      ["1020 REDONDO", 1200, "Pendente"],
      ["1045 REDONDO", 800, "Pendente"],
    ]);
  });

  it("proposta de outro cliente numa conversa: recusa sem devolver dado", async () => {
    const r = await crmGetProposalItems.handler({ proposta_id: PROPOSTA_V2 }, ctx({ contatoDoTurno: OUTRO_CONTATO }));
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(JSON.stringify(r)).not.toContain("REDONDO");
  });

  it("proposta de outra organização não é encontrada", async () => {
    const r = await crmGetProposalItems.handler({ proposta_id: PROPOSTA_V2 }, ctx({ organizationId: OUTRA_ORG }));
    expect(r).toMatchObject({ error: expect.stringContaining("não encontrada") });
  });

  it("capacidade propostas desligada: recusa", async () => {
    mocks.capacidades.mockResolvedValue([]);
    const r = await crmGetProposalItems.handler({ lead_id: LEAD }, ctx());
    expect(r).toMatchObject({ error: expect.stringContaining("desligadas") });
  });
});

describe("crm_update_proposal_items_status", () => {
  const item = (id: string) => banco.tabelas.crm_proposal_items!.find((l) => l.id === id)!;
  const v2 = () => banco.tabelas.crm_proposals!.find((p) => p.id === PROPOSTA_V2)!;

  it("o cliente fecha um e recusa outro: a proposta é aceita, o negócio vale o aceito e o efeito é declarado", async () => {
    const r = await crmUpdateProposalItemsStatus.handler(
      { lead_id: LEAD, itens: [{ id: ITEM_A, status: "aceito" }, { id: ITEM_B, status: "recusado" }] },
      ctx(),
    );
    expect(r).toMatchObject({ proposta_id: PROPOSTA_V2, status_da_proposta: "aceita" });
    expect(item(ITEM_A).status).toBe("aceito");
    expect(v2().status).toBe("aceita");
    // Agente não é pessoa: a coluna com FK para auth.users fica nula.
    expect(v2().decided_by_user_id).toBeNull();
    expect(banco.tabelas.crm_leads!.find((l) => l.id === LEAD)!.value_cents).toBe(1200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "proposal.item_status_changed", actorApiTokenId: "tok-1", actorUserId: null }),
    );
    expect(crmUpdateProposalItemsStatus.motivoDoVazio!(r)).toBeNull();
  });

  it("proposta que não é do negócio informado: recusa e nada muda", async () => {
    const r = await crmUpdateProposalItemsStatus.handler(
      { lead_id: OUTRO_LEAD, proposta_id: PROPOSTA_V2, itens: [{ id: ITEM_A, status: "aceito" }] },
      ctx(),
    );
    expect(r).toMatchObject({ motivo: "not_found" });
    expect(item(ITEM_A).status).toBe("pendente");
    expect(crmUpdateProposalItemsStatus.motivoDoVazio!(r)).toBe("not_found");
  });

  it("negócio de outro cliente na conversa: recusa antes de escrever", async () => {
    const r = await crmUpdateProposalItemsStatus.handler(
      { lead_id: LEAD, itens: [{ id: ITEM_A, status: "aceito" }] },
      ctx({ contatoDoTurno: OUTRO_CONTATO }),
    );
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(item(ITEM_A).status).toBe("pendente");
  });

  it("produção na cotação: a regra recusa, e a recusa não conta como efeito", async () => {
    const r = await crmUpdateProposalItemsStatus.handler(
      { lead_id: LEAD, itens: [{ id: ITEM_A, status: "em_producao" }] },
      ctx(),
    );
    expect(r).toMatchObject({ motivo: "validation_failed" });
    expect(crmUpdateProposalItemsStatus.motivoDoVazio!(r)).toBe("validation_failed");
    expect(item(ITEM_A).status).toBe("pendente");
  });
});
