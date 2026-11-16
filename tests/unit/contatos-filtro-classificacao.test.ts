/**
 * `?classificacao=` NA LISTA DE CONTATOS (migration 9257).
 *
 * O handler lê os prazos da ORGANIZAÇÃO, transforma as faixas escolhidas numa
 * expressão `or` sobre `last_won_at` e devolve cada contato com o selo
 * `classificacao` calculado pela mesma régua. O dublê aplica o `or` de verdade
 * (parse das faixas) para que o teste meça a linha que volta, não a string.
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { contactListQuerySchema } from "@/lib/schemas/contacts";

const ORG = "11111111-1111-4111-8111-111111111111";
const DIA = 86_400_000;
const haDias = (n: number) => new Date(Date.now() - n * DIA).toISOString();

function contato(id: string, ultimaVenda: string | null) {
  return {
    id,
    organization_id: ORG,
    kind: "person",
    display_name: id,
    is_blocked: false,
    is_personal: false,
    is_merged_into: null,
    tags: [],
    created_at: "2026-10-01T00:00:00.000Z",
    last_activity_at: "2026-10-02T00:00:00.000Z",
    last_won_at: ultimaVenda,
  };
}

type Linha = ReturnType<typeof contato>;

/** Avalia `last_won_at.gte.X`, `.lt.X`, `.is.null` e `and(...)` contra a linha. */
function casa(expr: string, r: Linha): boolean {
  const and = /^and\((.*)\)$/.exec(expr);
  if (and) return and[1]!.split(",").every((p) => casa(p, r));
  const [, op, valor] = /^last_won_at\.(gte|lt|is)\.(.*)$/.exec(expr) ?? [];
  const v = r.last_won_at;
  if (op === "is") return v === null;
  if (v === null) return false;
  return op === "gte" ? v >= valor! : v < valor!;
}

function dividirOr(expr: string): string[] {
  const partes: string[] = [];
  let nivel = 0;
  let atual = "";
  for (const ch of expr) {
    if (ch === "(") nivel += 1;
    if (ch === ")") nivel -= 1;
    if (ch === "," && nivel === 0) {
      partes.push(atual);
      atual = "";
    } else atual += ch;
  }
  partes.push(atual);
  return partes;
}

function banco(prazos: { ativo: number; pre: number } | null) {
  const linhas = [
    contato("recente", haDias(10)),
    contato("esfriando", haDias(120)),
    contato("antigo", haDias(400)),
    contato("nunca", null),
  ];
  return {
    from: (tabela: string) => ({
      select: () => {
        if (tabela === "organizations") {
          const q = {
            eq: () => q,
            maybeSingle: () =>
              Promise.resolve({
                data: prazos
                  ? { classificacao_ativo_dias: prazos.ativo, classificacao_pre_inativo_dias: prazos.pre }
                  : null,
                error: null,
              }),
          };
          return q;
        }
        if (tabela === "conversations") {
          const q: Record<string, unknown> = {};
          q.eq = () => q;
          q.in = () => q;
          q.order = () => Promise.resolve({ data: [], error: null });
          return q;
        }
        const filtros: Array<(r: Linha) => boolean> = [];
        const q: Record<string, unknown> = {
          eq: (coluna: string, valor: unknown) => {
            filtros.push((r) => (r as Record<string, unknown>)[coluna] === valor);
            return q;
          },
          is: () => q,
          or: (expr: string) => {
            filtros.push((r) => dividirOr(expr).some((p) => casa(p, r)));
            return q;
          },
          contains: () => q,
          order: () => q,
          limit: () => q,
          then: (ok: (v: unknown) => unknown) =>
            Promise.resolve({ data: linhas.filter((r) => filtros.every((f) => f(r))), error: null }).then(ok),
        };
        return q;
      },
    }),
  } as never;
}

const ctx = () => ({ organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req-1" }) as never;
const ids = (r: { contacts: Array<{ id: string }> }) => r.contacts.map((c) => c.id).sort();

describe("?classificacao filtra pela última venda ganha", () => {
  it("cada faixa sozinha, com os prazos padrão (90/180)", async () => {
    expect(ids(await listContactsHandler(banco(null), ctx(), { classificacao: "ativo" }))).toEqual(["recente"]);
    expect(ids(await listContactsHandler(banco(null), ctx(), { classificacao: "pre_inativo" }))).toEqual([
      "esfriando",
    ]);
    expect(ids(await listContactsHandler(banco(null), ctx(), { classificacao: "inativo" }))).toEqual(["antigo"]);
    expect(ids(await listContactsHandler(banco(null), ctx(), { classificacao: "sem_compra" }))).toEqual(["nunca"]);
  });

  it("várias faixas em OU", async () => {
    const r = await listContactsHandler(banco(null), ctx(), { classificacao: ["pre_inativo", "inativo"] });
    expect(ids(r)).toEqual(["antigo", "esfriando"]);
  });

  it("os prazos da organização mudam a faixa", async () => {
    // ativo até 150 dias: quem comprou há 120 dias volta a ser ativo.
    const r = await listContactsHandler(banco({ ativo: 150, pre: 500 }), ctx(), { classificacao: "ativo" });
    expect(ids(r)).toEqual(["esfriando", "recente"]);
  });

  it("cada contato volta com o selo da mesma régua", async () => {
    const r = await listContactsHandler(banco(null), ctx(), {});
    const selo = Object.fromEntries(r.contacts.map((c) => [c.id, c.classificacao]));
    expect(selo).toEqual({ recente: "ativo", esfriando: "pre_inativo", antigo: "inativo", nunca: "sem_compra" });
  });

  it("valor fora do vocabulário é recusado pelo schema", () => {
    expect(contactListQuerySchema.safeParse({ classificacao: "vip" }).success).toBe(false);
    expect(contactListQuerySchema.safeParse({ classificacao: [] }).data?.classificacao).toBeUndefined();
  });
});
