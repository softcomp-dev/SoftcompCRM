/**
 * Junta as listas de VÁRIAS empresas numa só, a mais recente primeiro.
 *
 * Conversas e Contatos da visão consolidada não têm cursor que atravesse
 * empresas: cada empresa devolve a sua primeira página (pelo handler de
 * sempre, com as regras de visibilidade de sempre) e aqui se junta. O que
 * passou do limite é avisado — `truncado` — para a tela não se apresentar como
 * lista completa.
 */
export interface ListaDaEmpresa<T> {
  organization_id: string;
  itens: T[];
  /** A empresa tinha mais do que devolveu. */
  tem_mais: boolean;
}

export function juntarPorData<T>(
  listas: ReadonlyArray<ListaDaEmpresa<T>>,
  dataDe: (item: T) => string | null | undefined,
  limite: number,
): { itens: Array<T & { organization_id: string }>; truncado: boolean } {
  const todos: Array<T & { organization_id: string }> = [];
  for (const l of listas) {
    for (const item of l.itens) todos.push({ ...item, organization_id: l.organization_id });
  }
  const ts = (item: T) => {
    const d = dataDe(item);
    const n = d ? Date.parse(d) : NaN;
    return Number.isNaN(n) ? -Infinity : n;
  };
  todos.sort((a, b) => ts(b) - ts(a));
  return {
    itens: todos.slice(0, limite),
    truncado: todos.length > limite || listas.some((l) => l.tem_mais),
  };
}
