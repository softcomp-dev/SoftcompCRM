/**
 * FUNIL CONSOLIDADO — como as etapas de várias empresas viram UMA fileira de
 * colunas.
 *
 * Decisão do dono do produto (10/11/2026): etapas com o MESMO NOME viram uma
 * coluna só, com os cards de todas as empresas; etapa que só existe numa
 * empresa aparece como coluna própria. "Mesmo nome" ignora maiúscula, acento
 * e espaço repetido ("Proposta enviada" = "proposta  ENVIADA").
 *
 * As etapas de GANHO e de PERDA se juntam pela marca (`is_won`/`is_lost`), não
 * pelo nome: "Ganho", "Fechado" e "Pago" são o mesmo desfecho, e cada funil tem
 * exatamente uma de cada (índices únicos `uniq_crm_stages_pipeline_won/lost`).
 * Sempre ficam no fim, ganho antes de perda.
 *
 * A ordem das colunas abertas é a posição RELATIVA média da etapa no próprio
 * funil (0 = primeira, 1 = última aberta): um funil de 3 etapas e outro de 7
 * se alinham pela proporção, não pelo índice cru.
 *
 * Puro; testado em `colunas.test.ts`.
 */

export interface EtapaDoFunil {
  id: string;
  organization_id: string;
  pipeline_id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
}

export interface FunilDaEmpresa {
  id: string;
  organization_id: string;
  name: string;
  is_default: boolean;
  position: number;
}

export type TipoDaColuna = "aberta" | "ganho" | "perdido";

export interface ColunaConsolidada {
  /** Chave estável da coluna (o nome normalizado, ou `__ganho` / `__perdido`). */
  chave: string;
  /** O nome mais frequente entre as etapas juntadas (empate: o da 1ª empresa). */
  rotulo: string;
  tipo: TipoDaColuna;
  /** As etapas reais que a coluna junta — uma por funil, no máximo. */
  etapas: Array<{ stage_id: string; pipeline_id: string; organization_id: string }>;
}

export const CHAVE_GANHO = "__ganho";
export const CHAVE_PERDIDO = "__perdido";

export function normalizarNomeDaEtapa(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A chave da coluna onde esta etapa cai. */
export function chaveDaEtapa(e: Pick<EtapaDoFunil, "name" | "is_won" | "is_lost">): string {
  if (e.is_won) return CHAVE_GANHO;
  if (e.is_lost) return CHAVE_PERDIDO;
  return normalizarNomeDaEtapa(e.name);
}

export function montarColunas(etapas: readonly EtapaDoFunil[]): ColunaConsolidada[] {
  // Posição relativa de cada etapa ABERTA dentro do próprio funil.
  const porFunil = new Map<string, EtapaDoFunil[]>();
  for (const e of etapas) {
    if (e.is_won || e.is_lost) continue;
    const lista = porFunil.get(e.pipeline_id) ?? [];
    lista.push(e);
    porFunil.set(e.pipeline_id, lista);
  }
  const relativa = new Map<string, number>();
  for (const lista of porFunil.values()) {
    lista.sort((a, b) => a.position - b.position);
    lista.forEach((e, i) => relativa.set(e.id, lista.length > 1 ? i / (lista.length - 1) : 0));
  }

  interface Acumulo {
    coluna: ColunaConsolidada;
    nomes: Map<string, number>;
    somaRelativa: number;
    ordemDeChegada: number;
  }
  const acumulos = new Map<string, Acumulo>();
  let chegada = 0;
  for (const e of etapas) {
    const chave = chaveDaEtapa(e);
    let a = acumulos.get(chave);
    if (!a) {
      a = {
        coluna: {
          chave,
          rotulo: e.name,
          tipo: e.is_won ? "ganho" : e.is_lost ? "perdido" : "aberta",
          etapas: [],
        },
        nomes: new Map(),
        somaRelativa: 0,
        ordemDeChegada: chegada++,
      };
      acumulos.set(chave, a);
    }
    a.coluna.etapas.push({
      stage_id: e.id,
      pipeline_id: e.pipeline_id,
      organization_id: e.organization_id,
    });
    a.nomes.set(e.name, (a.nomes.get(e.name) ?? 0) + 1);
    a.somaRelativa += relativa.get(e.id) ?? 0;
  }

  for (const a of acumulos.values()) {
    let melhor = a.coluna.rotulo;
    let vezes = 0;
    for (const [nome, n] of a.nomes) {
      if (n > vezes) {
        melhor = nome;
        vezes = n;
      }
    }
    a.coluna.rotulo = melhor;
  }

  const peso = (t: TipoDaColuna) => (t === "aberta" ? 0 : t === "ganho" ? 1 : 2);
  return [...acumulos.values()]
    .sort((x, y) => {
      const p = peso(x.coluna.tipo) - peso(y.coluna.tipo);
      if (p !== 0) return p;
      const mx = x.somaRelativa / x.coluna.etapas.length;
      const my = y.somaRelativa / y.coluna.etapas.length;
      if (mx !== my) return mx - my;
      return x.ordemDeChegada - y.ordemDeChegada;
    })
    .map((a) => a.coluna);
}

/**
 * Para onde vai um card arrastado para a coluna `chave`: a etapa daquela coluna
 * que pertence ao MESMO funil do card. `null` = o funil do card não tem etapa
 * com esse nome — mover para lá seria trocar de funil, que o produto proíbe
 * (P-01: troca de funil é clone).
 */
export function etapaDeDestino(
  coluna: ColunaConsolidada,
  pipelineDoCard: string,
): string | null {
  return coluna.etapas.find((e) => e.pipeline_id === pipelineDoCard)?.stage_id ?? null;
}

/**
 * QUAIS FUNIS entram na visão. Cada empresa pode ter vários; a escolha é:
 * - `padrao` — o funil padrão de cada empresa (ou o primeiro, se nenhum é);
 * - um NOME normalizado — o funil com esse nome em cada empresa que o tiver.
 */
export function escolherFunis(
  funis: readonly FunilDaEmpresa[],
  escolha: "padrao" | string,
): FunilDaEmpresa[] {
  const porEmpresa = new Map<string, FunilDaEmpresa[]>();
  for (const f of funis) {
    const lista = porEmpresa.get(f.organization_id) ?? [];
    lista.push(f);
    porEmpresa.set(f.organization_id, lista);
  }
  const escolhidos: FunilDaEmpresa[] = [];
  for (const lista of porEmpresa.values()) {
    lista.sort((a, b) => a.position - b.position);
    if (escolha === "padrao") {
      const f = lista.find((x) => x.is_default) ?? lista[0];
      if (f) escolhidos.push(f);
    } else {
      const f = lista.find((x) => normalizarNomeDaEtapa(x.name) === escolha);
      if (f) escolhidos.push(f);
    }
  }
  return escolhidos;
}

/** Os nomes de funil oferecidos no seletor (normalizado → rótulo), sem repetição. */
export function nomesDeFunil(funis: readonly FunilDaEmpresa[]): Array<{ chave: string; rotulo: string; empresas: number }> {
  const mapa = new Map<string, { rotulo: string; empresas: Set<string> }>();
  for (const f of funis) {
    const chave = normalizarNomeDaEtapa(f.name);
    const atual = mapa.get(chave) ?? { rotulo: f.name, empresas: new Set<string>() };
    atual.empresas.add(f.organization_id);
    mapa.set(chave, atual);
  }
  return [...mapa.entries()]
    .map(([chave, v]) => ({ chave, rotulo: v.rotulo, empresas: v.empresas.size }))
    .sort((a, b) => b.empresas - a.empresas || a.rotulo.localeCompare(b.rotulo));
}
