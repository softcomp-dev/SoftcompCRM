import { describe, expect, it } from "vitest";

import { desmarcarSdr, marcarSdr, recusaDeMarcacao } from "./atribuicao";
import type { MembroParaPermissao } from "./permissoes";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";

type Linha = MembroParaPermissao & { organization_id: string };

/**
 * Banco simulado que APLICA os filtros do UPDATE condicional sobre linhas em
 * memória — o teste mede a condição da escrita, não um mock que responde o
 * que o teste quer.
 */
function bancoCom(linhas: Linha[]) {
  function consulta(op: "select" | "update", valores?: Partial<Linha>) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const q = {
      eq: (c: keyof Linha, v: unknown) => (filtros.push((l) => l[c] === v), q),
      is: (c: keyof Linha, v: null) => (filtros.push((l) => l[c] === v), q),
      in: (c: keyof Linha, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      not: (c: keyof Linha, _op: "is", _v: null) => (filtros.push((l) => l[c] !== null), q),
      select: () => q,
      order: () => q,
      maybeSingle: async () => {
        const achadas = linhas.filter((l) => filtros.every((f) => f(l)));
        if (op === "update") for (const l of achadas) Object.assign(l, valores);
        const l = achadas[0];
        return {
          data: l ? { user_id: l.user_id, role: l.role, revoked_at: l.revoked_at, sdr_since: l.sdr_since } : null,
          error: null,
        };
      },
    };
    return q;
  }
  return {
    from: () => ({
      select: () => consulta("select"),
      update: (v: Partial<Linha>) => consulta("update", v),
    }),
  } as never;
}

const AGORA = new Date("2026-11-10T12:00:00.000Z");

function membro(p: Partial<Linha> = {}): Linha {
  return { organization_id: ORG, user_id: "u1", role: "agent", revoked_at: null, sdr_since: null, ...p };
}

describe("recusaDeMarcacao", () => {
  it("recusa ausente, revogado e viewer; aceita agent+", () => {
    expect(recusaDeMarcacao(null)).toEqual({ tipo: "nao_encontrado" });
    expect(recusaDeMarcacao(membro({ revoked_at: "2026-01-01" }))).toEqual({ tipo: "revogado" });
    expect(recusaDeMarcacao(membro({ role: "viewer" }))).toEqual({ tipo: "papel_insuficiente", role: "viewer" });
    expect(recusaDeMarcacao(membro({ role: "manager" }))).toBeNull();
  });
});

describe("marcarSdr", () => {
  it("marca um agent ativo com a hora da escrita", async () => {
    const linhas = [membro()];
    const r = await marcarSdr(bancoCom(linhas), ORG, "u1", AGORA);
    expect(r.tipo).toBe("marcado");
    expect(linhas[0]!.sdr_since).toBe(AGORA.toISOString());
  });

  it("é idempotente: marcar de novo não regrava a data", async () => {
    const linhas = [membro({ sdr_since: "2026-01-01T00:00:00.000Z" })];
    const r = await marcarSdr(bancoCom(linhas), ORG, "u1", AGORA);
    expect(r.tipo).toBe("ja_marcado");
    expect(linhas[0]!.sdr_since).toBe("2026-01-01T00:00:00.000Z");
  });

  it("não marca viewer nem revogado, e não escreve nada", async () => {
    const viewer = [membro({ role: "viewer" })];
    expect(await marcarSdr(bancoCom(viewer), ORG, "u1", AGORA)).toEqual({ tipo: "papel_insuficiente", role: "viewer" });
    expect(viewer[0]!.sdr_since).toBeNull();

    const revogado = [membro({ revoked_at: "2026-11-01T00:00:00Z" })];
    expect(await marcarSdr(bancoCom(revogado), ORG, "u1", AGORA)).toEqual({ tipo: "revogado" });
    expect(revogado[0]!.sdr_since).toBeNull();
  });

  it("não alcança o mesmo usuário em outra organização", async () => {
    const linhas = [membro({ organization_id: OUTRA_ORG })];
    expect(await marcarSdr(bancoCom(linhas), ORG, "u1", AGORA)).toEqual({ tipo: "nao_encontrado" });
    expect(linhas[0]!.sdr_since).toBeNull();
  });
});

describe("desmarcarSdr", () => {
  it("desmarca e é idempotente", async () => {
    const linhas = [membro({ sdr_since: "2026-01-01T00:00:00.000Z" })];
    expect((await desmarcarSdr(bancoCom(linhas), ORG, "u1")).tipo).toBe("desmarcado");
    expect(linhas[0]!.sdr_since).toBeNull();
    expect((await desmarcarSdr(bancoCom(linhas), ORG, "u1")).tipo).toBe("nao_marcado");
  });

  it("desmarca membro revogado (limpeza é permitida)", async () => {
    const linhas = [membro({ revoked_at: "2026-11-01T00:00:00Z", sdr_since: "2026-01-01T00:00:00.000Z" })];
    expect((await desmarcarSdr(bancoCom(linhas), ORG, "u1")).tipo).toBe("desmarcado");
  });

  it("membro de outra organização: não encontrado", async () => {
    const linhas = [membro({ organization_id: OUTRA_ORG, sdr_since: "2026-01-01T00:00:00.000Z" })];
    expect(await desmarcarSdr(bancoCom(linhas), ORG, "u1")).toEqual({ tipo: "nao_encontrado" });
    expect(linhas[0]!.sdr_since).not.toBeNull();
  });
});
