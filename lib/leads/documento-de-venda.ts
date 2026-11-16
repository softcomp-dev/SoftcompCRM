/**
 * O documento de venda do negócio: o número da COTAÇÃO ou do PEDIDO (migration 9260).
 *
 *   `sales_document_kind`   — `quote` (cotação) ou `order` (pedido);
 *   `sales_document_number` — o número como o ERP o escreve (1..60 caracteres).
 *
 * O negócio é uma coisa OU a outra, nunca as duas: por isso é UM tipo e UM
 * número, e não duas colunas de número. O banco recusa o par incompleto
 * (`crm_leads_documento_de_venda_coerente`); esta régua é a mesma, do lado de
 * cá, para a tela e o PATCH não chegarem lá com o par quebrado.
 */

export const TIPOS_DE_DOCUMENTO_DE_VENDA = ["quote", "order"] as const;
export type TipoDeDocumentoDeVenda = (typeof TIPOS_DE_DOCUMENTO_DE_VENDA)[number];

/** O tipo que a tela sugere quando a pessoa digita um número sem escolher. */
export const TIPO_DE_DOCUMENTO_PADRAO: TipoDeDocumentoDeVenda = "quote";

export const TAMANHO_MAXIMO_DO_NUMERO = 60;

export interface DocumentoDeVenda {
  sales_document_kind: TipoDeDocumentoDeVenda | null;
  sales_document_number: string | null;
}

export interface DocumentoDeVendaNoPatch {
  sales_document_kind?: TipoDeDocumentoDeVenda | null;
  sales_document_number?: string | null;
}

/**
 * Esta escrita menciona o documento? Separa "não mexi" (o PATCH não toca nas
 * colunas) de "apaguei o número" (`sales_document_number: null`). Sem a
 * distinção, todo PATCH de título apagaria o número do pedido.
 */
export function mencionaDocumentoDeVenda(patch: DocumentoDeVendaNoPatch): boolean {
  return patch.sales_document_kind !== undefined || patch.sales_document_number !== undefined;
}

export type LeituraDoDocumento =
  | { ok: true; par: DocumentoDeVenda }
  | { ok: false; motivo: "numero_sem_tipo" | "numero_longo_demais" };

/**
 * O par que vai para o banco, já coerente.
 *
 * - número vazio ou nulo LIMPA o par (o tipo vai junto: tipo sem número não diz nada);
 * - número presente sem tipo é recusa — ninguém saberia se é cotação ou pedido;
 * - o número é gravado sem espaço nas pontas (o CHECK do banco exige).
 */
export function documentoParaGravar(patch: DocumentoDeVendaNoPatch): LeituraDoDocumento {
  const numero = (patch.sales_document_number ?? "").trim();
  if (numero.length === 0) {
    return { ok: true, par: { sales_document_kind: null, sales_document_number: null } };
  }
  if (numero.length > TAMANHO_MAXIMO_DO_NUMERO) return { ok: false, motivo: "numero_longo_demais" };
  const tipo = patch.sales_document_kind ?? null;
  if (tipo === null) return { ok: false, motivo: "numero_sem_tipo" };
  return { ok: true, par: { sales_document_kind: tipo, sales_document_number: numero } };
}

/** "Cotação" / "Pedido" — o rótulo do tipo, em português (a tela passa por `t()`). */
export function rotuloDoTipoDeDocumento(tipo: TipoDeDocumentoDeVenda): string {
  return tipo === "order" ? "Pedido" : "Cotação";
}
