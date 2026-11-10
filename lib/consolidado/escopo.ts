/**
 * VISÃO CONSOLIDADA — quais empresas entram na tela.
 *
 * A régua é sempre a mesma: a pessoa vê, de uma vez, as empresas das quais é
 * membro ativa (vínculo aceito, não revogado, empresa operante). O filtro da
 * tela (`?empresas=a,b` ou nenhum = todas) só ESTREITA esse conjunto, nunca o
 * alarga: um id que não é dela some em silêncio — perguntar por ele não pode
 * nem confirmar que a empresa existe.
 *
 * A RLS já recusaria a leitura de empresa alheia (`fn_user_org_ids()`), mas a
 * RLS também libera tudo para o platform admin: é por isso que o escopo se
 * decide aqui, pelos vínculos, e toda consulta da visão filtra
 * `organization_id in (escopo)` explicitamente.
 *
 * Puro; quem lê os vínculos do banco é `lib/consolidado/servidor.ts`.
 */
import type { Role } from "@/lib/auth/types";

export interface EmpresaDoEscopo {
  organization_id: string;
  nome: string;
  role: Role;
}

/** Quantas empresas cabem numa consulta da visão (teto do `.in()`). */
export const TETO_DE_EMPRESAS_NA_VISAO = 200;

/** Lê `?empresas=` cru: lista de ids separados por vírgula; vazio = todas. */
export function lerEmpresasDaUrl(bruto: string | null | undefined): string[] {
  if (!bruto) return [];
  return [
    ...new Set(
      bruto
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f-]{36}$/i.test(s)),
    ),
  ];
}

/**
 * As empresas da visão: as pedidas que são da pessoa, ou todas as dela quando
 * nada foi pedido (ou nada do que foi pedido é dela). Ordem: a dos vínculos.
 */
export function empresasDoEscopo(
  vinculos: readonly EmpresaDoEscopo[],
  pedidas: readonly string[],
): EmpresaDoEscopo[] {
  const pedidasSet = new Set(pedidas);
  const filtradas = pedidas.length > 0 ? vinculos.filter((v) => pedidasSet.has(v.organization_id)) : [];
  const escopo = filtradas.length > 0 ? filtradas : [...vinculos];
  return escopo.slice(0, TETO_DE_EMPRESAS_NA_VISAO);
}
