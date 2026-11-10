import { describe, expect, it, vi } from "vitest";

import { carregarFluxoDeDistribuicao, fluxoDeDistribuicao } from "./distribuicao";
import type { MembroParaPermissao } from "./permissoes";

const marcado = (user_id: string, extra: Partial<MembroParaPermissao> = {}): MembroParaPermissao => ({
  user_id,
  role: "agent",
  revoked_at: null,
  sdr_since: "2026-11-01T00:00:00Z",
  ...extra,
});

describe("fluxoDeDistribuicao — os dois fluxos", () => {
  it("função desligada: equipe inteira, mesmo com gente marcada", () => {
    expect(fluxoDeDistribuicao(false, [marcado("ana")])).toEqual({ fluxo: "equipe", motivo: "funcao_desligada" });
  });

  it("ligada sem ninguém marcado: equipe inteira (configuração incompleta não para os leads)", () => {
    expect(fluxoDeDistribuicao(true, [])).toEqual({ fluxo: "equipe", motivo: "nenhum_sdr_ativo" });
  });

  it("ligada com marcas todas sem efeito: equipe inteira", () => {
    expect(
      fluxoDeDistribuicao(true, [
        marcado("rebaixado", { role: "viewer" }),
        marcado("revogado", { revoked_at: "2026-11-02T00:00:00Z" }),
      ]),
    ).toEqual({ fluxo: "equipe", motivo: "nenhum_sdr_ativo" });
  });

  it("ligada com SDR ativo: só os ativos recebem", () => {
    const r = fluxoDeDistribuicao(true, [marcado("ana"), marcado("bia", { role: "manager" }), marcado("rebaixado", { role: "viewer" })]);
    expect(r.fluxo).toBe("sdr");
    if (r.fluxo === "sdr") expect([...r.userIds].sort()).toEqual(["ana", "bia"]);
  });
});

describe("carregarFluxoDeDistribuicao", () => {
  function banco(resposta: { data: unknown; error: { message: string } | null }) {
    const filtros: Array<[string, unknown]> = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      not: (c: string) => (filtros.push([c, "not null"]), q),
      then: (res: (v: unknown) => void) => res(resposta),
    };
    const from = vi.fn(() => q);
    return { db: { from } as never, from, filtros };
  }

  it("função desligada nem consulta o banco", async () => {
    const { db, from } = banco({ data: [], error: null });
    expect(await carregarFluxoDeDistribuicao(db, "org", { sdr: { enabled: false } })).toEqual({
      fluxo: "equipe",
      motivo: "funcao_desligada",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("ligada: lê só os marcados desta organização", async () => {
    const { db, filtros } = banco({ data: [marcado("ana")], error: null });
    const r = await carregarFluxoDeDistribuicao(db, "org-1", { sdr: { enabled: true } });
    expect(r.fluxo).toBe("sdr");
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["sdr_since", "not null"]);
  });

  it("erro de leitura lança: não entrega o lead do SDR para a equipe", async () => {
    const { db } = banco({ data: null, error: { message: "offline" } });
    await expect(carregarFluxoDeDistribuicao(db, "org", { sdr: { enabled: true } })).rejects.toThrow("offline");
  });
});
