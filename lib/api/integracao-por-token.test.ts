import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

import { falhaDoHandlerParaToken, recusaDaEtapaParaToken } from "./integracao-por-token";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;

/** Banco em memória que APLICA os filtros — organização inclusive. */
function banco(tabelas: Record<string, Linha[]>) {
  return {
    from: (tabela: string) => {
      const filtros: Array<(l: Linha) => boolean> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        maybeSingle: async () => ({
          data: (tabelas[tabela] ?? []).find((l) => filtros.every((f) => f(l))) ?? null,
          error: null,
        }),
      };
      return q;
    },
  } as never;
}

const etapa = (extra: Linha = {}) => ({
  id: ETAPA,
  organization_id: ORG,
  pipeline_id: FUNIL,
  is_won: false,
  is_lost: false,
  is_archived: false,
  ...extra,
});
const funil = (extra: Linha = {}) => ({ id: FUNIL, organization_id: ORG, is_archived: false, ...extra });

const perguntar = (tabelas: Record<string, Linha[]>, uso: "criar" | "mover", organizationId = ORG) =>
  recusaDaEtapaParaToken(banco(tabelas), { organizationId, stageId: ETAPA, uso, requestId: "req" });

const motivoDe = async (r: Response | null) =>
  r ? ((await r.json()) as { error: { details: { motivo: string } } }).error.details.motivo : null;

describe("recusaDaEtapaParaToken", () => {
  it("etapa aberta em funil ativo serve para criar e para mover", async () => {
    const tabelas = { crm_stages: [etapa()], crm_pipelines: [funil()] };
    expect(await perguntar(tabelas, "criar")).toBeNull();
    expect(await perguntar(tabelas, "mover")).toBeNull();
  });

  it("etapa arquivada recusa criar e mover com 422", async () => {
    const tabelas = { crm_stages: [etapa({ is_archived: true })], crm_pipelines: [funil()] };
    for (const uso of ["criar", "mover"] as const) {
      const r = await perguntar(tabelas, uso);
      expect(r?.status).toBe(422);
      expect(await motivoDe(r)).toBe("etapa_arquivada");
    }
  });

  it("etapa de ganho ou de perda recusa CRIAR, mas mover é exatamente para isso", async () => {
    for (const fechamento of [{ is_won: true }, { is_lost: true }]) {
      const tabelas = { crm_stages: [etapa(fechamento)], crm_pipelines: [funil()] };
      expect(await motivoDe(await perguntar(tabelas, "criar"))).toBe("etapa_de_fechamento");
      expect(await perguntar(tabelas, "mover")).toBeNull();
    }
  });

  it("funil arquivado recusa", async () => {
    const tabelas = { crm_stages: [etapa()], crm_pipelines: [funil({ is_archived: true })] };
    expect(await motivoDe(await perguntar(tabelas, "criar"))).toBe("funil_arquivado");
  });

  it("etapa de OUTRA organização não é lida: quem responde é o handler (404)", async () => {
    const tabelas = { crm_stages: [etapa({ is_archived: true })], crm_pipelines: [funil()] };
    expect(await perguntar(tabelas, "criar", OUTRA)).toBeNull();
  });
});

describe("falhaDoHandlerParaToken", () => {
  it("falha interna não leva o texto do banco ao integrador", async () => {
    const r = falhaDoHandlerParaToken(
      new ApiError(500, "internal_error", undefined, "req", "null value in column stage_id violates not-null constraint"),
      "req",
      "POST /api/v1/leads",
    );
    expect(r.status).toBe(500);
    const corpo = JSON.stringify(await r.json());
    expect(corpo).not.toContain("stage_id");
    expect(corpo).toContain("X-Request-Id");
  });

  it("recusa de negócio chega inteira, com details", async () => {
    const r = falhaDoHandlerParaToken(
      new ApiError(422, "required_fields_missing", { faltando: [{ chave: "pedido" }] }, "req", "Faltam campos."),
      "req",
      "POST /api/v1/leads",
    );
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: unknown }).error).toMatchObject({
      code: "required_fields_missing",
      message: "Faltam campos.",
      details: { faltando: [{ chave: "pedido" }] },
    });
  });
});
