// components/kanban/PropostasDoNegocio.tsx
"use client";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";

import { StatusDoItem, type RespostaDosItens } from "@/components/propostas/StatusDoItem";
import { useT } from "@/hooks/i18n/useT";
import { useItensDaProposta } from "@/hooks/kanban/useItensDaProposta";
import { usePropostasDoLead, type PropostaDoLead } from "@/hooks/kanban/usePropostasDoLead";
import { formatCents } from "@/lib/money";
import { calcularTotal } from "@/lib/propostas/total";

const ROTULO_DE_STATUS: Record<string, string> = {
  rascunho: "Rascunho", enviando: "Enviando", enviada: "Enviada", aceita: "Aceita",
  recusada: "Recusada", vencida: "Vencida", cancelada: "Cancelada", substituida: "Substituída",
};

interface Props {
  leadId: string;
  pipelineId: string;
  /** N1 — o atalho "Nova proposta" é `manager`+; o dossiê já sabe o papel de quem está vendo. */
  podeCriar?: boolean;
  /** 9261 — mudar o status dos itens é `agent`+, a régua da rota de itens. */
  podeDecidirItens?: boolean;
}

/** Proposta que já saiu de cena: a cancelada e a substituída por uma versão nova. */
const FORA_DE_CENA = new Set(["cancelada", "substituida"]);

/**
 * A proposta cujos itens o card mostra: a mais recente que ainda vale. A lista
 * já chega da mais nova para a mais velha (`order created_at desc` na rota).
 */
export function propostaVigente(propostas: readonly PropostaDoLead[] | undefined): PropostaDoLead | null {
  return propostas?.find((p) => !FORA_DE_CENA.has(p.status)) ?? null;
}

const formatoDaQuantidade = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

/**
 * N1 — seção "Propostas" do dossiê, depois de "Dados do negócio".
 *
 * Erro de leitura (inclusive o 404 de capacidade desligada, `sePropostasDesligadas`):
 * a seção some em vez de quebrar o dossiê — a página dedicada de Propostas é
 * quem mostra erro, aqui é só um resumo agregado.
 */
export function PropostasDoNegocio({ leadId, pipelineId, podeCriar = false, podeDecidirItens = false }: Props): React.ReactElement | null {
  const t = useT();
  const { data: propostas, isLoading, isError } = usePropostasDoLead(leadId);
  const vigente = propostaVigente(propostas);

  if (isError) return null;

  return (
    <div className="border-t border-border pt-3">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">{t("Propostas")}</h3>
      {isLoading && <p className="text-xs text-text-muted">{t("Carregando…")}</p>}
      {!isLoading && (propostas?.length ?? 0) === 0 && (
        <p className="text-xs text-text-muted">{t("Nenhuma proposta ainda")}</p>
      )}
      {!isLoading && propostas && propostas.length > 0 && (
        <ul className="space-y-1">
          {propostas.map((p) => (
            <li key={p.id}>
              <Link href={`/app/proposals/${p.id}`} className="flex items-center justify-between text-xs hover:underline">
                <span>
                  {p.numero ? `${String(p.numero).padStart(4, "0")}/${p.ano}` : t("Rascunho")}
                  {p.versao > 1 ? ` — v${p.versao}` : ""} · {t(ROTULO_DE_STATUS[p.status] ?? p.status)}
                </span>
                <span>{formatCents(p.total_cents, p.moeda)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {vigente && (
        <ItensDaPropostaVigente
          propostaId={vigente.id}
          leadId={leadId}
          pipelineId={pipelineId}
          podeDecidir={podeDecidirItens}
        />
      )}
      {podeCriar && (
        <Link
          href={`/app/proposals/novo?lead_id=${leadId}`}
          className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
        >
          {t("Nova proposta")}
        </Link>
      )}
    </div>
  );
}

/**
 * 9261 — os produtos negociados no card: a tabela de itens da proposta
 * vigente, com o status de cada um. Na cotação o cliente responde item a item;
 * quando o negócio vira pedido, o item aceito anda para produção e entrega.
 */
function ItensDaPropostaVigente({
  propostaId,
  leadId,
  pipelineId,
  podeDecidir,
}: {
  propostaId: string;
  leadId: string;
  pipelineId: string;
  podeDecidir: boolean;
}): React.ReactElement | null {
  const t = useT();
  const qc = useQueryClient();
  const { data: proposta, isError } = useItensDaProposta(propostaId);

  if (isError || !proposta || proposta.itens.length === 0) return null;

  function aoMudar(resposta: RespostaDosItens) {
    void qc.invalidateQueries({ queryKey: ["proposals", "detalhe", propostaId] });
    // A proposta pode ter se resolvido com este item (e o valor do negócio
    // mudado junto): a lista de propostas e o quadro recarregam.
    if (resposta.status !== proposta?.status) {
      void qc.invalidateQueries({ queryKey: ["proposals", "por-lead", leadId] });
      void qc.invalidateQueries({ queryKey: ["board", pipelineId] });
    }
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <caption className="sr-only">{t("Itens da proposta")}</caption>
        <thead className="bg-muted text-text-muted">
          <tr>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("Descrição")}</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("Valor unitário")}</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("Quantidade")}</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("Total")}</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("Status")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {proposta.itens.map((it) => (
            <tr key={it.id}>
              <td className="px-2 py-1.5">{it.descricao}</td>
              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                {it.preco_unitario_cents === null ? t("A definir") : formatCents(it.preco_unitario_cents, proposta.moeda)}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatoDaQuantidade.format(it.quantidade)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                {it.preco_unitario_cents === null ? t("A definir") : formatCents(calcularTotal([it]), proposta.moeda)}
              </td>
              <td className="px-2 py-1.5">
                <StatusDoItem
                  propostaId={proposta.id}
                  itemId={it.id}
                  status={it.status}
                  fase={proposta.fase_dos_itens}
                  podeEditar={podeDecidir}
                  onMudou={aoMudar}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
