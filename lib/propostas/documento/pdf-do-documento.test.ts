// @vitest-environment node
//
// O ambiente é `node` (e não o jsdom da suíte) porque os casos do cabeçalho
// precisam LER o texto de dentro do PDF: em jsdom o `pdfjs-dist` que o
// `extractPdfText` usa abre o arquivo e devolve "no text" com
// `Bad FCHECK in flate stream` — o mesmo motor que extrai o PDF do RAG na
// produção. Nenhum caso deste arquivo toca DOM: o react-pdf renderiza igual
// nos dois ambientes.
import { describe, expect, it } from "vitest";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";

import { blocosDoDocumento, pdfMostraStatusDosItens, renderDocumentoPdf, type DocumentoPdfInput } from "./pdf-do-documento";

const secao = (id: string) => ({ id, title: id, body: `corpo ${id}`, faltantes: [] });

const BASE: DocumentoPdfInput = {
  titulo: "Proposta de Teste",
  numero: 12,
  ano: 2026,
  versao: 1,
  destinatario: { nome: "Maria" },
  secoes: [secao("summary"), secao("investment"), secao("terms")],
  itens: [{ descricao: "Site", quantidade: 1, precoUnitarioCents: 350000, descontoCents: 0, imagemUrl: null }],
  totalCents: 350000,
  moeda: "BRL",
  validUntil: "2026-10-16",
  condicoes: "50% no aceite",
  marca: { app_name: "Acme", accent_hex: null, logoUrl: null },
};

describe("blocosDoDocumento", () => {
  it("os itens entram logo depois da seção de investimento (§6.2 da spec de 21/09)", () => {
    expect(blocosDoDocumento(BASE.secoes).map((b) => (b.tipo === "itens" ? "itens" : b.secao.id))).toEqual([
      "summary",
      "investment",
      "itens",
      "terms",
    ]);
  });

  it("modelo sem seção de investimento: itens no fim", () => {
    expect(blocosDoDocumento([secao("a"), secao("b")]).map((b) => (b.tipo === "itens" ? "itens" : b.secao.id))).toEqual([
      "a",
      "b",
      "itens",
    ]);
  });

  it("zero seções: só os itens", () => {
    expect(blocosDoDocumento([])).toEqual([{ tipo: "itens" }]);
  });
});

describe("renderDocumentoPdf", () => {
  it("gera um PDF (buffer não vazio) com cabeçalho, seções e itens", async () => {
    const buf = await renderDocumentoPdf(BASE);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it("gera mesmo com ZERO seções e sem número (rascunho), sem lançar", async () => {
    const buf = await renderDocumentoPdf({ ...BASE, secoes: [], numero: null, ano: null, condicoes: null, validUntil: null });
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  // C2 da spec de 27/09 — a prévia ("Ver como o cliente recebe") não aloca
  // número, e o lugar que ele ocuparia no cabeçalho DIZ que não existe: um
  // lugar em branco ali se lê como "o PDF saiu incompleto".
  it("previa: onde entraria 'Proposta 0000/AAAA' aparece 'Prévia — sem número'", async () => {
    const buf = await renderDocumentoPdf({ ...BASE, numero: null, ano: null, previa: true });
    const texto = await extractPdfText(buf);
    expect(texto).toContain("Prévia — sem número");
    expect(texto).not.toContain("Proposta 0012/2026");
  });

  it("sem prévia e sem número, o cabeçalho não inventa número nem aviso", async () => {
    const buf = await renderDocumentoPdf({ ...BASE, numero: null, ano: null });
    const texto = await extractPdfText(buf);
    expect(texto).not.toContain("Prévia — sem número");
    expect(texto).not.toContain("Proposta 0000");
  });
});

describe("status dos itens no PDF (9261)", () => {
  const DOIS_ITENS: DocumentoPdfInput = {
    ...BASE,
    itens: [
      { descricao: "1020 REDONDO", quantidade: 1, precoUnitarioCents: 120000, descontoCents: 0, imagemUrl: null },
      { descricao: "1045 REDONDO", quantidade: 1, precoUnitarioCents: 80000, descontoCents: 0, imagemUrl: null },
    ],
    totalCents: 200000,
  };

  it("tudo pendente (o PDF do envio): nenhuma palavra de status, e o total de sempre", async () => {
    const itens = DOIS_ITENS.itens.map((it) => ({ ...it, status: "pendente" as const }));
    expect(pdfMostraStatusDosItens(itens)).toBe(false);
    const texto = await extractPdfText(await renderDocumentoPdf({ ...DOIS_ITENS, itens }));
    expect(texto).not.toMatch(/Pendente|Total aceito/);
    expect(texto).toContain("Total:");
  });

  it("aceite parcial: cada linha diz o status e o total separa o aceito do proposto", async () => {
    const [a, b] = DOIS_ITENS.itens;
    const itens = [
      { ...a!, status: "aceito" as const },
      { ...b!, status: "recusado" as const },
    ];
    expect(pdfMostraStatusDosItens(itens)).toBe(true);
    const texto = await extractPdfText(await renderDocumentoPdf({ ...DOIS_ITENS, itens }));
    expect(texto).toContain("1020 REDONDO (x1) — Aceito");
    expect(texto).toContain("1045 REDONDO (x1) — Recusado");
    expect(texto).toMatch(/Total aceito: R\$\s?1\.200,00/);
    expect(texto).toMatch(/Total proposto: R\$\s?2\.000,00/);
  });

  it("tudo aceito e em produção: mostra o status, e um total só (aceito = proposto)", async () => {
    const itens = DOIS_ITENS.itens.map((it) => ({ ...it, status: "em_producao" as const }));
    const texto = await extractPdfText(await renderDocumentoPdf({ ...DOIS_ITENS, itens }));
    expect(texto).toContain("— Em produção");
    expect(texto).not.toContain("Total aceito");
  });
});
