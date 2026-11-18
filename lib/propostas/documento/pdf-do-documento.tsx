// lib/propostas/documento/pdf-do-documento.tsx
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

import { formatarMoeda } from "../moeda";
import { ROTULO_DO_STATUS_DO_ITEM, valorVendidoCents } from "../status-do-item";
import type { StatusDoItemDaProposta } from "../tipos";
import type { SecaoRenderizada } from "./renderer";

const styles = StyleSheet.create({
  page: { padding: 32, paddingBottom: 48, fontSize: 10 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  logo: { width: 96, height: 40, objectFit: "contain" },
  titulo: { fontSize: 16, fontWeight: 700 },
  secaoTitulo: { fontSize: 12, fontWeight: 700, marginTop: 12, marginBottom: 4 },
  secaoBody: { fontSize: 10, lineHeight: 1.4 },
  linhaItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 0.5 },
  itemImagem: { width: 32, height: 32, objectFit: "cover", marginRight: 8 },
  itemTexto: { flexDirection: "row", alignItems: "center" },
  total: { marginTop: 8, fontSize: 12, fontWeight: 700, textAlign: "right" },
  totalProposto: { marginTop: 2, fontSize: 9, color: "#666", textAlign: "right" },
  itemRecusado: { color: "#999" },
  footer: { position: "absolute", bottom: 24, left: 32, right: 32, fontSize: 8, color: "#666" },
});

export interface ItemDoPdf {
  descricao: string;
  quantidade: number;
  precoUnitarioCents: number;
  descontoCents: number;
  imagemUrl?: string | null;
  /** 9261 — status do item. Ausente ou só `pendente`: o PDF não mostra status. */
  status?: StatusDoItemDaProposta;
}

/**
 * 9261 — o PDF só fala de status DEPOIS que o cliente respondeu. No envio todo
 * item é pendente, e o documento que o cliente recebe continua igual ao de
 * sempre; na prévia de uma proposta já decidida, cada linha diz o que foi
 * aceito, recusado, produzido ou entregue.
 */
export function pdfMostraStatusDosItens(itens: readonly ItemDoPdf[]): boolean {
  return itens.some((it) => it.status !== undefined && it.status !== "pendente");
}

export interface DocumentoPdfInput {
  titulo: string;
  numero: number | null;
  ano: number | null;
  versao: number;
  destinatario: { nome: string };
  secoes: SecaoRenderizada[];
  itens: ItemDoPdf[];
  totalCents: number;
  moeda: string;
  validUntil: string | null;
  condicoes: string | null;
  /** SÓ a organização (D6 da spec-mãe) — quem monta é `marcaDaOrganizacaoParaPdf`. */
  marca: { app_name: string | null; accent_hex: string | null; logoUrl: string | null };
  /**
   * PRÉVIA DE TELA ("Ver como o cliente recebe"): o arquivo é o mesmo que o
   * envio faria, mas o número ainda não existe — e o lugar dele diz isso, em vez
   * de ficar em branco (quem lê não pode confundir "sem número" com "faltou
   * alguma coisa no PDF").
   */
  previa?: boolean;
}

export type BlocoDoPdf = { tipo: "secao"; secao: SecaoRenderizada } | { tipo: "itens" };

const ID_DA_SECAO_DE_INVESTIMENTO = "investment";

/** A ordem de leitura da §6.2 da spec de 21/09: a tabela de itens mora dentro do investimento. */
export function blocosDoDocumento(secoes: SecaoRenderizada[]): BlocoDoPdf[] {
  const blocos: BlocoDoPdf[] = [];
  let itensColocados = false;
  for (const secao of secoes) {
    blocos.push({ tipo: "secao", secao });
    if (secao.id === ID_DA_SECAO_DE_INVESTIMENTO && !itensColocados) {
      blocos.push({ tipo: "itens" });
      itensColocados = true;
    }
  }
  if (!itensColocados) blocos.push({ tipo: "itens" });
  return blocos;
}

function Itens({ d, accent }: { d: DocumentoPdfInput; accent: string | undefined }): React.ReactElement {
  const comStatus = pdfMostraStatusDosItens(d.itens);
  const vendido = comStatus
    ? valorVendidoCents(
        d.itens.map((it) => ({
          status: it.status ?? "pendente",
          quantidade: it.quantidade,
          preco_unitario_cents: it.precoUnitarioCents,
          desconto_cents: it.descontoCents,
        })),
      )
    : d.totalCents;
  return (
    <View style={{ marginTop: 8 }}>
      {d.itens.map((it, i) => {
        const recusado = it.status === "recusado";
        return (
          <View key={i} style={[styles.linhaItem, recusado ? styles.itemRecusado : {}]}>
            <View style={styles.itemTexto}>
              {it.imagemUrl ? <Image src={it.imagemUrl} style={styles.itemImagem} /> : null}
              <Text>
                {it.descricao} (x{it.quantidade})
                {comStatus && it.status ? ` — ${ROTULO_DO_STATUS_DO_ITEM[it.status]}` : ""}
              </Text>
            </View>
            <Text>{formatarMoeda(it.quantidade * it.precoUnitarioCents - it.descontoCents, d.moeda)}</Text>
          </View>
        );
      })}
      {comStatus && vendido !== d.totalCents ? (
        <>
          <Text style={[styles.total, accent ? { color: accent } : {}]}>Total aceito: {formatarMoeda(vendido, d.moeda)}</Text>
          <Text style={styles.totalProposto}>Total proposto: {formatarMoeda(d.totalCents, d.moeda)}</Text>
        </>
      ) : (
        <Text style={[styles.total, accent ? { color: accent } : {}]}>Total: {formatarMoeda(d.totalCents, d.moeda)}</Text>
      )}
    </View>
  );
}

function DocumentoPdfDoc({ d }: { d: DocumentoPdfInput }): React.ReactElement {
  const accent = d.marca.accent_hex ?? undefined;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={[styles.titulo, accent ? { color: accent } : {}]}>{d.titulo}</Text>
            {d.previa ? (
              <Text>Prévia — sem número</Text>
            ) : d.numero !== null && d.ano !== null ? (
              <Text>
                Proposta {String(d.numero).padStart(4, "0")}/{d.ano}
                {d.versao > 1 ? ` — v${d.versao}` : ""}
              </Text>
            ) : null}
          </View>
          {d.marca.logoUrl ? (
            <Image src={d.marca.logoUrl} style={styles.logo} />
          ) : d.marca.app_name ? (
            <Text>{d.marca.app_name}</Text>
          ) : null}
        </View>

        <Text>Para: {d.destinatario.nome}</Text>

        {blocosDoDocumento(d.secoes).map((bloco, i) =>
          bloco.tipo === "itens" ? (
            <Itens key={`itens-${i}`} d={d} accent={accent} />
          ) : (
            <View key={bloco.secao.id} wrap>
              <Text style={styles.secaoTitulo}>{bloco.secao.title}</Text>
              <Text style={styles.secaoBody}>{bloco.secao.body}</Text>
            </View>
          ),
        )}

        {d.validUntil ? <Text style={{ marginTop: 12 }}>Válida até {d.validUntil}</Text> : null}
        {d.condicoes ? <Text style={{ marginTop: 8 }}>{d.condicoes}</Text> : null}

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${d.marca.app_name ?? "Proposta comercial"} — página ${pageNumber} de ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}

export async function renderDocumentoPdf(input: DocumentoPdfInput): Promise<Buffer> {
  const buf = await renderToBuffer(<DocumentoPdfDoc d={input} />);
  return buf as Buffer;
}
