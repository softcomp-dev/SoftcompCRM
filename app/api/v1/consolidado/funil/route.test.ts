/**
 * GET /api/v1/consolidado/funil — o teto é POR ETAPA.
 *
 * Até aqui o corte era por funil, ordenado por `position_in_stage` — que só
 * ordena dentro de uma etapa. Num funil com mais de 500 negócios, uma etapa
 * inteira podia sumir do quadro sem aviso. O banco em memória abaixo APLICA
 * filtro, ordem e limite, para a prova medir o corte de verdade.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TETO_DE_NEGOCIOS_POR_ETAPA } from "@/lib/consolidado/colunas";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";

import { GET } from "./route";

vi.mock("@/lib/consolidado/servidor", () => ({ abrirVisaoConsolidada: vi.fn() }));
vi.mock("@/app/api/v1/conversations/_handler", () => ({
  idsDeContatosPessoais: vi.fn(async (_db: unknown, org: string) => (org === ORG ? [PESSOAL] : [])),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const FUNIL = "f0000000-0000-4000-8000-000000000001";
const CHEIA = "e0000000-0000-4000-8000-00000000000a";
const VIZINHA = "e0000000-0000-4000-8000-00000000000b";
const PESSOAL = "c0000000-0000-4000-8000-0000000000ff";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;

function consulta(tabela: string) {
  const filtros: Array<(l: Linha) => boolean> = [];
  const ordens: string[] = [];
  let teto = Infinity;
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
    neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
    in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
    order: (c: string) => (ordens.push(c), q),
    limit: (n: number) => ((teto = n), q),
    then: (res: (v: unknown) => void) => {
      const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      for (const c of [...ordens].reverse()) linhas.sort((a, b) => Number(a[c] ?? 0) - Number(b[c] ?? 0));
      res({ data: linhas.slice(0, teto), error: null });
    },
  };
  return q;
}

const negocio = (stage: string, i: number, extra: Linha = {}) => ({
  id: `${stage.slice(-2)}-${i}`,
  organization_id: ORG,
  pipeline_id: FUNIL,
  stage_id: stage,
  contact_id: null,
  title: `Negócio ${i}`,
  status: "open",
  value_cents: null,
  currency: null,
  position_in_stage: i,
  updated_at: "2026-11-13T00:00:00.000Z",
  closed_at: null,
  last_activity_at: null,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    crm_pipelines: [{ id: FUNIL, organization_id: ORG, name: "Vendas", is_default: true, position: 0, settings: {}, is_archived: false }],
    crm_stages: [
      { id: CHEIA, organization_id: ORG, pipeline_id: FUNIL, name: "Novo", position: 1, is_won: false, is_lost: false, is_archived: false },
      { id: VIZINHA, organization_id: ORG, pipeline_id: FUNIL, name: "Proposta", position: 2, is_won: false, is_lost: false, is_archived: false },
    ],
    crm_leads: [
      // A etapa cheia vem PRIMEIRO pela posição: no corte antigo, por funil, ela
      // tomava todas as vagas.
      ...Array.from({ length: TETO_DE_NEGOCIOS_POR_ETAPA + 5 }, (_, i) => negocio(CHEIA, i)),
      negocio(VIZINHA, 1000),
      negocio(VIZINHA, 1001),
      negocio(VIZINHA, 1002, { contact_id: PESSOAL }),
    ],
  };
  vi.mocked(abrirVisaoConsolidada).mockResolvedValue({
    ok: true,
    supabase: { from: (t: string) => consulta(t) },
    escopo: [{ organization_id: ORG, nome: "Empresa", role: "admin" }],
    vinculos: [{ organization_id: ORG, nome: "Empresa", role: "admin" }],
  } as never);
});

describe("GET /api/v1/consolidado/funil", () => {
  it("cada etapa tem o próprio teto: a cheia é cortada e a vizinha aparece inteira", async () => {
    const res = await GET(new NextRequest("http://localhost/api/v1/consolidado/funil"));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { negocios: Array<{ stage_id: string }>; etapas_truncadas: string[]; truncados: string[] };
    };

    const naCheia = data.negocios.filter((n) => n.stage_id === CHEIA).length;
    const naVizinha = data.negocios.filter((n) => n.stage_id === VIZINHA).length;
    expect(naCheia).toBe(TETO_DE_NEGOCIOS_POR_ETAPA);
    // Duas: a terceira é de contato pessoal, que nunca aparece no quadro.
    expect(naVizinha).toBe(2);
    expect(data.etapas_truncadas).toEqual([CHEIA]);
    expect(data.truncados).toEqual([FUNIL]);
  });

  it("sem etapa cheia, nada é marcado como cortado", async () => {
    tabelas.crm_leads = [negocio(CHEIA, 1), negocio(VIZINHA, 2)];
    const { data } = (await (await GET(new NextRequest("http://localhost/api/v1/consolidado/funil"))).json()) as {
      data: { negocios: unknown[]; etapas_truncadas: string[]; truncados: string[] };
    };
    expect(data.negocios).toHaveLength(2);
    expect(data.etapas_truncadas).toEqual([]);
    expect(data.truncados).toEqual([]);
  });
});
