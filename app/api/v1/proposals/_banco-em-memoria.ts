/**
 * Banco em memória para os testes das portas por token (empresas, anexos e
 * propostas). Ele APLICA os filtros (`eq`, `in`, `gt`, `lt`, `is`) — sem isso,
 * uma rota que esquecesse o `organization_id` passaria por construção e o teste
 * mentiria a favor do produto. `or` é ignorado (só a paginação o usa).
 *
 * Só serve a teste; nada de produção importa este arquivo.
 */
import { randomUUID } from "node:crypto";

type Linha = Record<string, unknown>;
type Erro = { code?: string; message: string } | null;

export interface BancoEmMemoria {
  tabelas: Record<string, Linha[]>;
  client: {
    from: (tabela: string) => unknown;
    storage: { from: (bucket: string) => unknown };
  };
  /** Cada upload: `{ bucket, caminho }`. */
  uploads: Array<{ bucket: string; caminho: string }>;
  removidos: string[];
  /** Tabelas cujo próximo insert falha com este erro. */
  falharInsert: Record<string, Erro>;
}

/** Colunas únicas por tabela: o índice único do Postgres devolveria 23505. */
const UNICOS: Record<string, string[]> = {
  idempotency_keys: ["organization_id", "key", "endpoint"],
};

export function criarBanco(): BancoEmMemoria {
  const tabelas: Record<string, Linha[]> = {};
  const uploads: BancoEmMemoria["uploads"] = [];
  const removidos: string[] = [];
  const falharInsert: Record<string, Erro> = {};

  function from(tabela: string) {
    const linhas = (tabelas[tabela] ??= []);
    const filtros: Array<(l: Linha) => boolean> = [];
    let modo: "select" | "insert" | "update" | "delete" = "select";
    let corpo: Linha | Linha[] = {};
    const ordem: Array<{ c: string; asc: boolean }> = [];
    let teto = Infinity;
    let colunas: string[] | null = null;
    let executado: { data: Linha[]; error: Erro } | null = null;

    const executa = (): { data: Linha[]; error: Erro } => {
      if (executado) return executado;
      if (modo === "insert") {
        if (falharInsert[tabela]) return (executado = { data: [], error: falharInsert[tabela]! });
        const novas = (Array.isArray(corpo) ? corpo : [corpo]).map((c): Linha => ({
          id: randomUUID(),
          created_at: new Date().toISOString(),
          ...c,
        }));
        for (const n of novas) {
          const cols = UNICOS[tabela];
          if (cols && linhas.some((l) => cols.every((c) => l[c] === n[c]))) {
            return (executado = { data: [], error: { code: "23505", message: "duplicate key" } });
          }
        }
        linhas.push(...novas);
        return (executado = { data: novas, error: null });
      }
      const alvo = linhas.filter((l) => filtros.every((f) => f(l)));
      if (modo === "update") {
        for (const l of alvo) Object.assign(l, corpo);
        return (executado = { data: alvo, error: null });
      }
      if (modo === "delete") {
        for (const l of alvo) linhas.splice(linhas.indexOf(l), 1);
        return (executado = { data: alvo, error: null });
      }
      let saida = [...alvo];
      for (const o of [...ordem].reverse()) {
        saida.sort((a, b) => {
          const x = String(a[o.c] ?? "");
          const y = String(b[o.c] ?? "");
          return o.asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      saida = saida.slice(0, teto);
      // Projeção: a coluna que a rota não pediu não chega (é o que prova o select explícito).
      if (colunas) saida = saida.map((l) => Object.fromEntries(colunas!.filter((c) => c in l).map((c) => [c, l[c]])));
      return (executado = { data: saida, error: null });
    };

    const primeira = async (obrigatoria: boolean) => {
      const r = executa();
      if (r.error) return { data: null, error: r.error };
      const l = r.data[0] ?? null;
      if (!l && obrigatoria) return { data: null, error: { message: "no rows" } };
      return { data: l, error: null };
    };

    const b: Record<string, unknown> = {
      select: (cols?: string) => {
        if (modo === "select" && cols && cols !== "*") colunas = cols.split(",").map((c) => c.trim());
        return b;
      },
      insert: (c: Linha | Linha[]) => ((modo = "insert"), (corpo = c), b),
      update: (c: Linha) => ((modo = "update"), (corpo = c), b),
      delete: () => ((modo = "delete"), b),
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), b),
      in: (c: string, v: unknown[]) => (filtros.push((l) => v.includes(l[c])), b),
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), b),
      lt: (c: string, v: string) => (filtros.push((l) => String(l[c]) < v), b),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), b),
      or: () => b,
      order: (c: string, o?: { ascending?: boolean }) => (ordem.push({ c, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((teto = n), b),
      maybeSingle: () => primeira(false),
      single: () => primeira(true),
      then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(executa()).then(ok, ko),
    };
    return b;
  }

  const client = {
    from,
    storage: {
      from: (bucket: string) => ({
        upload: async (caminho: string) => {
          uploads.push({ bucket, caminho });
          return { error: null };
        },
        remove: async (caminhos: string[]) => {
          removidos.push(...caminhos);
          return { error: null };
        },
        createSignedUrl: async (caminho: string) => ({
          data: { signedUrl: `https://storage.exemplo/${bucket}/${caminho}?token=x` },
          error: null,
        }),
      }),
    },
  };

  return { tabelas, client, uploads, removidos, falharInsert };
}
