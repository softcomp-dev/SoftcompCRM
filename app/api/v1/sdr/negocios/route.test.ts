/**
 * GET /api/v1/sdr/negocios — só o SDR ativo recebe a lista, com as mesmas
 * recusas da passagem. A leitura dos negócios (`carregarNegociosDoSdr`) entra
 * como espião: aqui se mede QUEM a rota deixa ler e com que organização.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { carregarNegociosDoSdr } from "@/lib/sdr/negocios-do-sdr";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ sessao: true })) }));
vi.mock("@/lib/sdr/negocios-do-sdr", () => ({ carregarNegociosDoSdr: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const SDR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VENDEDOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;

function consulta(tabela: string) {
  const filtros: Array<(l: Linha) => boolean> = [];
  const executar = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).map((l) => ({ ...l }));
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
    maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
    then: (res: (v: unknown) => void) => res({ data: executar(), error: null }),
  };
  return q;
}

function comoUsuario(userId: string) {
  vi.mocked(requireRole).mockImplementation((async () => ({
    ok: true,
    user: { id: userId, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  })) as never);
}

const membro = (org: string, user_id: string, extra: Linha = {}) => ({
  organization_id: org,
  user_id,
  role: "agent",
  revoked_at: null,
  sdr_since: null,
  accepted_at: "2026-11-01T00:00:00.000Z",
  ...extra,
});

const chamar = () => GET(new NextRequest("http://localhost/api/v1/sdr/negocios"));

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    organizations: [
      { id: ORG, settings: { sdr: { enabled: true } } },
      { id: OUTRA, settings: { sdr: { enabled: true } } },
    ],
    user_organizations: [
      membro(ORG, SDR, { sdr_since: "2026-11-01T00:00:00.000Z" }),
      membro(ORG, VENDEDOR),
      // SDR na OUTRA organização não vale aqui.
      membro(OUTRA, VENDEDOR, { sdr_since: "2026-11-01T00:00:00.000Z" }),
    ],
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: (t: string) => ({ select: () => consulta(t) }) } as never);
  vi.mocked(carregarNegociosDoSdr).mockResolvedValue({
    ok: true,
    negocios: [{ id: "n1" }] as never,
    truncado: false,
  });
});

describe("GET /api/v1/sdr/negocios", () => {
  it("o SDR ativo recebe a lista, lida pela sessão e na organização do cookie", async () => {
    comoUsuario(SDR);
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data).toEqual([{ id: "n1" }]);
    expect(corpo.meta).toEqual({ total: 1, has_more: false });
    expect(carregarNegociosDoSdr).toHaveBeenCalledWith(
      await vi.mocked(createClient).mock.results[0]?.value,
      expect.objectContaining({ organizationId: ORG, sdrId: SDR }),
    );
  });

  it("avisa quando a lista passou do teto", async () => {
    comoUsuario(SDR);
    vi.mocked(carregarNegociosDoSdr).mockResolvedValue({ ok: true, negocios: [], truncado: true });
    const corpo = await (await chamar()).json();
    expect(corpo.meta.has_more).toBe(true);
  });

  it("quem não é SDR nesta organização recebe 403 e não lê nada", async () => {
    comoUsuario(VENDEDOR);
    const res = await chamar();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("sdr_handoff_forbidden");
    expect(carregarNegociosDoSdr).not.toHaveBeenCalled();
  });

  it("função desligada responde 409 sdr_disabled", async () => {
    tabelas.organizations = [{ id: ORG, settings: { sdr: { enabled: false } } }];
    comoUsuario(SDR);
    const res = await chamar();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("sdr_disabled");
    expect(carregarNegociosDoSdr).not.toHaveBeenCalled();
  });

  it("falha de leitura vira 500, nunca lista vazia", async () => {
    comoUsuario(SDR);
    vi.mocked(carregarNegociosDoSdr).mockResolvedValue({ ok: false, mensagem: "boom" });
    expect((await chamar()).status).toBe(500);
  });

  it("papel abaixo de agent é barrado antes de tudo", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    expect((await chamar()).status).toBe(403);
    expect(carregarNegociosDoSdr).not.toHaveBeenCalled();
  });
});
