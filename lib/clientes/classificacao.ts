/**
 * CLASSIFICAÇÃO DO CLIENTE POR RECÊNCIA DE COMPRA — a régua ÚNICA.
 *
 * Um contato é classificado pela data da ÚLTIMA VENDA GANHA
 * (`contacts.last_won_at`, mantida pelo gatilho de `crm_leads`) comparada aos
 * dois prazos da organização (`organizations.classificacao_ativo_dias` e
 * `organizations.classificacao_pre_inativo_dias`):
 *
 *   sem venda ganha                      → sem_compra
 *   última venda há até `ativoDias`      → ativo
 *   até `preInativoDias`                 → pre_inativo
 *   depois disso                         → inativo
 *
 * A classificação é CALCULADA, nunca gravada (DIRC "C"): o que muda com o
 * tempo sem que nada aconteça não pode morar numa coluna sincronizada por
 * cron. A lista, a ficha, o filtro, o público de campanha e o aviso da Central
 * perguntam aqui — `classificar` para uma linha, `cortesDaClassificacao` para
 * transformar a faixa em intervalo de `last_won_at` numa consulta. As duas
 * usam a mesma conta em milissegundos, então a linha que o filtro devolve é a
 * linha que o selo classifica.
 */

export const CLASSIFICACOES = ["ativo", "pre_inativo", "inativo", "sem_compra"] as const;
export type Classificacao = (typeof CLASSIFICACOES)[number];

export type LimitesDeClassificacao = {
  /** Até quantos dias depois da última venda ganha o cliente é ativo. */
  ativoDias: number;
  /** Até quantos dias é pré-inativo. Sempre maior que `ativoDias`. */
  preInativoDias: number;
};

/** Os defaults das colunas de `organizations`. */
export const LIMITES_PADRAO: LimitesDeClassificacao = { ativoDias: 90, preInativoDias: 180 };

/** Faixa aceita pelo CHECK do banco, repetida aqui para o Zod da tela. */
export const DIAS_MINIMO = 1;
export const DIAS_MAXIMO = 3650;

const DIA_MS = 86_400_000;

function instante(valor: string | Date): number {
  return typeof valor === "string" ? Date.parse(valor) : valor.getTime();
}

export function classificar(
  ultimaVendaGanha: string | Date | null | undefined,
  limites: LimitesDeClassificacao,
  agora: Date = new Date(),
): Classificacao {
  if (!ultimaVendaGanha) return "sem_compra";
  const t = instante(ultimaVendaGanha);
  if (Number.isNaN(t)) return "sem_compra";
  const decorrido = agora.getTime() - t;
  if (decorrido <= limites.ativoDias * DIA_MS) return "ativo";
  if (decorrido <= limites.preInativoDias * DIA_MS) return "pre_inativo";
  return "inativo";
}

/**
 * Os dois instantes que separam as faixas, em ISO:
 *
 *   ativo        last_won_at >= ativoDesde
 *   pre_inativo  preInativoDesde <= last_won_at < ativoDesde
 *   inativo      last_won_at < preInativoDesde
 *   sem_compra   last_won_at is null
 */
export function cortesDaClassificacao(
  limites: LimitesDeClassificacao,
  agora: Date = new Date(),
): { ativoDesde: string; preInativoDesde: string } {
  return {
    ativoDesde: new Date(agora.getTime() - limites.ativoDias * DIA_MS).toISOString(),
    preInativoDesde: new Date(agora.getTime() - limites.preInativoDias * DIA_MS).toISOString(),
  };
}

/** Lê os prazos da linha de `organizations`, caindo no padrão se faltarem. */
export function limitesDaOrganizacao(
  org: { classificacao_ativo_dias?: number | null; classificacao_pre_inativo_dias?: number | null } | null | undefined,
): LimitesDeClassificacao {
  const ativoDias = org?.classificacao_ativo_dias ?? LIMITES_PADRAO.ativoDias;
  const preInativoDias = org?.classificacao_pre_inativo_dias ?? LIMITES_PADRAO.preInativoDias;
  if (preInativoDias <= ativoDias) return LIMITES_PADRAO;
  return { ativoDias, preInativoDias };
}

export const ROTULO_DA_CLASSIFICACAO: Record<Classificacao, string> = {
  ativo: "Ativo",
  pre_inativo: "Pré-inativo",
  inativo: "Inativo",
  sem_compra: "Sem compra",
};

/**
 * As faixas escolhidas como UMA expressão `or` do PostgREST sobre
 * `last_won_at` (OU entre as faixas). Devolve `null` quando a escolha cobre
 * todas — sem filtro é o mesmo resultado, e mais barato.
 */
export function filtroOrDaClassificacao(
  escolhidas: readonly Classificacao[],
  limites: LimitesDeClassificacao,
  agora: Date = new Date(),
): string | null {
  const unicas = [...new Set(escolhidas)];
  if (unicas.length === 0 || unicas.length === CLASSIFICACOES.length) return null;
  const { ativoDesde, preInativoDesde } = cortesDaClassificacao(limites, agora);
  const partes = unicas.map((c) => {
    switch (c) {
      case "ativo":
        return `last_won_at.gte.${ativoDesde}`;
      case "pre_inativo":
        return `and(last_won_at.gte.${preInativoDesde},last_won_at.lt.${ativoDesde})`;
      case "inativo":
        return `last_won_at.lt.${preInativoDesde}`;
      case "sem_compra":
        return "last_won_at.is.null";
    }
  });
  return partes.join(",");
}
