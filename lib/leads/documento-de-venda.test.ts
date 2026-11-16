import { describe, expect, it } from "vitest";
import { updateLeadSchema } from "@/lib/schemas/leads";
import { documentoParaGravar, mencionaDocumentoDeVenda } from "./documento-de-venda";

describe("documento de venda do negócio (cotação OU pedido)", () => {
  it("grava o par com o número sem espaço nas pontas", () => {
    expect(documentoParaGravar({ sales_document_kind: "order", sales_document_number: "  PV-0123/26 " })).toEqual({
      ok: true,
      par: { sales_document_kind: "order", sales_document_number: "PV-0123/26" },
    });
  });

  it("número vazio limpa o par inteiro, o tipo junto", () => {
    for (const numero of ["", "   ", null, undefined]) {
      expect(documentoParaGravar({ sales_document_kind: "quote", sales_document_number: numero })).toEqual({
        ok: true,
        par: { sales_document_kind: null, sales_document_number: null },
      });
    }
  });

  it("número sem tipo é recusa: ninguém saberia se é cotação ou pedido", () => {
    expect(documentoParaGravar({ sales_document_kind: null, sales_document_number: "123" })).toEqual({
      ok: false,
      motivo: "numero_sem_tipo",
    });
  });

  it("número acima de 60 caracteres é recusa", () => {
    expect(documentoParaGravar({ sales_document_kind: "quote", sales_document_number: "9".repeat(61) })).toEqual({
      ok: false,
      motivo: "numero_longo_demais",
    });
  });

  it("PATCH que não menciona o documento não toca nele", () => {
    expect(mencionaDocumentoDeVenda({})).toBe(false);
    expect(mencionaDocumentoDeVenda({ sales_document_number: null })).toBe(true);
    expect(mencionaDocumentoDeVenda({ sales_document_kind: "order" })).toBe(true);
  });

  it("o schema do PATCH aceita só cotação ou pedido como tipo", () => {
    expect(updateLeadSchema.safeParse({ sales_document_kind: "order", sales_document_number: "1" }).success).toBe(true);
    expect(updateLeadSchema.safeParse({ sales_document_kind: "invoice" }).success).toBe(false);
    expect(updateLeadSchema.safeParse({ sales_document_number: "9".repeat(61) }).success).toBe(false);
  });
});
