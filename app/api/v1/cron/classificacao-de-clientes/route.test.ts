/**
 * O cron que avisa na Central o cliente que virou pré-inativo.
 *
 * O dublê do admin client devolve, por tabela, o que o banco devolveria e
 * registra cada escrita. Mede o EFEITO: quantos avisos nasceram, para quem a
 * marca andou e se a rodada auditou só quando fez algo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const DIA = 86_400_000;
const haDias = (n: number) => new Date(Date.now() - n * DIA).toISOString();

interface Mundo {
  contatos: Array<{ id: string; last_won_at: string; pre_inativo_avisado_para: string | null }>;
  avisoAberto: Set<string>;
  inseridos: Array<Record<string, unknown>>;
  marcas: Array<{ id: string; patch: Record<string, unknown> }>;
}

function admin(m: Mundo) {
  return {
    from(tabela: string) {
      let op: "select" | "insert" | "update" = "select";
      let patch: Record<string, unknown> = {};
      let refId: string | null = null;
      let contatoId: string | null = null;
      const chain: Record<string, unknown> = {};
      const devolve = () => chain;
      for (const nome of ["select", "is", "or", "gte", "lt", "order", "limit"]) chain[nome] = devolve;
      chain.eq = (col: string, val: string) => {
        if (col === "ref_id") refId = val;
        if (col === "id") contatoId = val;
        return chain;
      };
      chain.insert = (linha: Record<string, unknown>) => {
        m.inseridos.push(linha);
        return Promise.resolve({ error: null });
      };
      chain.update = (p: Record<string, unknown>) => {
        op = "update";
        patch = p;
        return chain;
      };
      chain.maybeSingle = () =>
        Promise.resolve({ data: refId && m.avisoAberto.has(refId) ? { id: "aviso" } : null, error: null });
      chain.then = (ok: (v: unknown) => unknown) => {
        if (op === "update") {
          m.marcas.push({ id: contatoId as string, patch });
          return Promise.resolve({ error: null }).then(ok);
        }
        if (tabela === "organizations") {
          return Promise.resolve({
            data: [
              {
                id: ORG,
                status: "active",
                locale: "pt-BR",
                timezone: "America/Sao_Paulo",
                classificacao_ativo_dias: 90,
                classificacao_pre_inativo_dias: 180,
              },
            ],
            error: null,
          }).then(ok);
        }
        return Promise.resolve({ data: m.contatos, error: null }).then(ok);
      };
      void op;
      return chain;
    },
  };
}

const req = () => new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });

beforeEach(() => vi.clearAllMocks());

describe("classificacao-de-clientes", () => {
  it("avisa uma vez por venda e grava a marca", async () => {
    const vendaNova = haDias(92);
    const m: Mundo = {
      contatos: [
        { id: "novo", last_won_at: vendaNova, pre_inativo_avisado_para: null },
        { id: "ja-avisado", last_won_at: haDias(93), pre_inativo_avisado_para: haDias(93) },
        { id: "com-aviso-aberto", last_won_at: haDias(94), pre_inativo_avisado_para: haDias(300) },
      ],
      avisoAberto: new Set(["com-aviso-aberto"]),
      inseridos: [],
      marcas: [],
    };
    vi.mocked(createAdminClient).mockReturnValue(admin(m) as never);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { avisados: number; marcados: number } };

    // Só "novo" ganha aviso: "ja-avisado" tem a marca da mesma venda, e
    // "com-aviso-aberto" já tem um item aberto na Central (só a marca anda).
    expect(m.inseridos).toHaveLength(1);
    expect(m.inseridos[0]).toMatchObject({
      organization_id: ORG,
      kind: "client_pre_inactive",
      ref_kind: "contact",
      ref_id: "novo",
    });
    expect(String(m.inseridos[0]!.body)).not.toMatch(/novo/);
    expect(m.marcas.map((x) => x.id).sort()).toEqual(["com-aviso-aberto", "novo"]);
    expect(m.marcas.find((x) => x.id === "novo")!.patch).toEqual({ pre_inativo_avisado_para: vendaNova });
    expect(corpo.data).toMatchObject({ avisados: 1, marcados: 2 });
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
  });

  it("rodada sem ninguém a avisar não audita", async () => {
    const m: Mundo = {
      contatos: [{ id: "ja-avisado", last_won_at: haDias(93), pre_inativo_avisado_para: haDias(93) }],
      avisoAberto: new Set(),
      inseridos: [],
      marcas: [],
    };
    vi.mocked(createAdminClient).mockReturnValue(admin(m) as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(m.inseridos).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("sem o segredo do cron, recusa", async () => {
    const res = await GET(new NextRequest("http://localhost/x"));
    expect(res.status).toBe(403);
  });
});
