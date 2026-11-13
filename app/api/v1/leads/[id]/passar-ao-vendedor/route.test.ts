/**
 * A passagem do SDR para o vendedor — as duas rotas (`GET /api/v1/sdr/vendedores`
 * e `POST /api/v1/leads/[id]/passar-ao-vendedor`) contra um banco em memória que
 * APLICA os filtros, organização inclusive. A edição do negócio
 * (`updateLeadHandler`) é a porta de sempre e entra como espião: aqui se mede
 * QUEM a rota deixa passar e o que ela passa junto.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { updateLeadHandler } from "../../_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({ registrarTrocaDeComando: vi.fn(async () => undefined) }));
vi.mock("../../_handler", () => ({ updateLeadHandler: vi.fn(async () => ({})) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const SDR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VENDEDOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTRO_SDR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COLEGA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DE_FORA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LEAD = "99999999-9999-4999-8999-999999999999";
const CONTATO = "88888888-8888-4888-8888-888888888888";
const CONVERSA = "77777777-7777-4777-8777-777777777777";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;
/** O que a função da carteira responde: `null` passa, texto é a recusa do banco. */
let recusaDaCarteira: string | null;
let rpcs: Array<{ nome: string; args: Linha }>;

function consulta(tabela: string) {
  const filtros: Array<(l: Linha) => boolean> = [];
  const executar = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).map((l) => ({ ...l }));
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
    in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
    maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
    then: (res: (v: unknown) => void) => res({ data: executar(), error: null }),
  };
  return q;
}

/** Passa as conversas abertas do contato que estão com `de` para `para`. */
function passarConversas(contato: unknown, de: unknown, para: unknown) {
  for (const c of tabelas.conversations ?? []) {
    if (c.contact_id === contato && c.assigned_to_user_id === de) c.assigned_to_user_id = para;
  }
}

function adminDb() {
  return {
    from: (t: string) => ({ select: () => consulta(t) }),
    rpc: async (nome: string, args: Linha) => {
      rpcs.push({ nome, args });
      if (nome === "fn_definir_carteira_do_cliente") {
        if (recusaDaCarteira) return { data: null, error: { message: recusaDaCarteira } };
        // A carteira que era do SDR leva as conversas dele (#3642).
        passarConversas(args.p_contact, args.p_actor, args.p_dono);
        return { data: args.p_dono, error: null };
      }
      return { data: null, error: null };
    },
  };
}

function sessaoDb() {
  return {
    rpc: (nome: string, args: Linha) => {
      rpcs.push({ nome, args });
      if (nome === "fn_conversation_assign") {
        const c = (tabelas.conversations ?? []).find((x) => x.id === args.p_conversation_id);
        if (c) c.assigned_to_user_id = args.p_to_user_id;
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function comoUsuario(userId: string) {
  vi.mocked(requireRole).mockImplementation((async () => ({
    ok: true,
    user: { id: userId, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  })) as never);
}

const membro = (org: string, user_id: string, role: string, extra: Linha = {}) => ({
  organization_id: org,
  user_id,
  role,
  revoked_at: null,
  sdr_since: null,
  accepted_at: "2026-11-01T00:00:00.000Z",
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  recusaDaCarteira = null;
  rpcs = [];
  tabelas = {
    organizations: [
      { id: ORG, settings: { sdr: { enabled: true } } },
      { id: OUTRA, settings: { sdr: { enabled: true } } },
    ],
    user_organizations: [
      membro(ORG, SDR, "agent", { sdr_since: "2026-11-01T00:00:00.000Z" }),
      membro(ORG, OUTRO_SDR, "agent", { sdr_since: "2026-11-01T00:00:00.000Z" }),
      membro(ORG, VENDEDOR, "agent"),
      membro(ORG, COLEGA, "manager"),
      membro(OUTRA, DE_FORA, "agent"),
    ],
    crm_leads: [{ id: LEAD, organization_id: ORG, status: "open", owner_user_id: SDR, contact_id: CONTATO }],
    conversations: [
      { id: CONVERSA, organization_id: ORG, contact_id: CONTATO, status: "open", assigned_to_user_id: SDR },
    ],
  };
  vi.mocked(createAdminClient).mockImplementation(() => adminDb() as never);
  vi.mocked(createClient).mockImplementation((async () => sessaoDb()) as never);
  comoUsuario(SDR);
});

const rota = () => import("./route");
const vendedores = () => import("../../../sdr/vendedores/route");

function passar(userId: string, lead = LEAD) {
  return rota().then(({ POST }) =>
    POST(
      new NextRequest(`http://localhost/api/v1/leads/${lead}/passar-ao-vendedor`, {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: lead }) },
    ),
  );
}

describe("GET /api/v1/sdr/vendedores", () => {
  it("o SDR vê só quem pode receber: nem ele, nem outro SDR, nem gente de outra empresa", async () => {
    const { GET } = await vendedores();
    const corpo = await (await GET(new NextRequest("http://localhost/api/v1/sdr/vendedores"))).json();
    expect(corpo.data).toEqual({ user_id: SDR, pode_passar: true, motivo: null, vendedores: [VENDEDOR, COLEGA] });
  });

  it("quem não é SDR recebe a lista vazia e o motivo, sem 403", async () => {
    comoUsuario(VENDEDOR);
    const { GET } = await vendedores();
    const r = await GET(new NextRequest("http://localhost/api/v1/sdr/vendedores"));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ user_id: VENDEDOR, pode_passar: false, motivo: "not_assigned", vendedores: [] });
  });
});

describe("POST /api/v1/leads/[id]/passar-ao-vendedor", () => {
  it("passa o negócio, a carteira e a conversa, e audita", async () => {
    const r = await passar(VENDEDOR);
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({
      lead_id: LEAD,
      owner_user_id: VENDEDOR,
      carteira: "passou",
      carteira_motivo: null,
      conversas_passadas: 1,
      conversas_que_ficaram: 0,
    });
    expect(updateLeadHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organization_id: ORG, actor: expect.objectContaining({ id: SDR }) }),
      LEAD,
      { owner_user_id: VENDEDOR },
      // A condição vai no UPDATE: o que a rota leu é o que ela exige ao gravar.
      { somenteSe: { status: "open", owner_user_id: SDR } },
    );
    expect(rpcs.find((c) => c.nome === "fn_definir_carteira_do_cliente")?.args).toMatchObject({
      p_org: ORG,
      p_actor: SDR,
      p_dono: VENDEDOR,
      p_origem: "manual",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sdr.lead_handed_off", resourceId: LEAD, organizationId: ORG }),
    );
  });

  it("com a carteira de outro vendedor, a conversa do SDR passa pelo Transferir e a resposta diz o que ficou", async () => {
    recusaDaCarteira = "carteira_permissao_negada";
    const corpo = (await (await passar(VENDEDOR)).json()).data;
    expect(corpo).toMatchObject({ carteira: "nao_passou", carteira_motivo: "cliente_de_outro_vendedor", conversas_passadas: 1 });
    expect(rpcs.find((c) => c.nome === "fn_conversation_assign")?.args).toMatchObject({
      p_organization_id: ORG,
      p_conversation_id: CONVERSA,
      p_to_user_id: VENDEDOR,
      p_reason: "transfer",
      p_negocio_so_sem_dono: true,
    });
  });

  it("quem não é SDR ativo recebe 403 e nada é tocado", async () => {
    comoUsuario(VENDEDOR);
    const r = await passar(COLEGA);
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("sdr_handoff_forbidden");
    expect(updateLeadHandler).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
  });

  it("com a função desligada, 409 sdr_disabled", async () => {
    tabelas.organizations![0]!.settings = { sdr: { enabled: false } };
    const r = await passar(VENDEDOR);
    expect(r.status).toBe(409);
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });

  it("recusa passar para outro SDR, para si mesmo e para alguém de outra empresa", async () => {
    for (const alvo of [OUTRO_SDR, SDR, DE_FORA]) {
      expect((await passar(alvo)).status).toBe(422);
    }
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });

  it("negócio de um colega é 403; encerrado é 409; de outra empresa é 404", async () => {
    tabelas.crm_leads![0]!.owner_user_id = COLEGA;
    expect((await passar(VENDEDOR)).status).toBe(403);

    tabelas.crm_leads![0]!.owner_user_id = SDR;
    tabelas.crm_leads![0]!.status = "won";
    expect((await passar(VENDEDOR)).status).toBe(409);

    tabelas.crm_leads![0]!.organization_id = OUTRA;
    expect((await passar(VENDEDOR)).status).toBe(404);
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });

  it("negócio sem dono humano (fila ou agente de IA) o SDR pode passar", async () => {
    tabelas.crm_leads![0]!.owner_user_id = null;
    expect((await passar(VENDEDOR)).status).toBe(200);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]?.[4]).toEqual({
      somenteSe: { status: "open", owner_user_id: null },
    });
  });

  it("se o negócio mudou de dono no meio (outro SDR chegou antes), 409 e nada mais passa", async () => {
    // A gravação condicional não casou linha nenhuma: `updateLeadHandler` recusa.
    vi.mocked(updateLeadHandler).mockRejectedValueOnce(
      new ApiError(409, "state_conflict", undefined, "req", "Este negócio mudou enquanto você trabalhava nele."),
    );
    const r = await passar(VENDEDOR);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("state_conflict");
    // Nem carteira, nem conversa, nem auditoria de passagem que não aconteceu.
    expect(rpcs).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});
