"use client";

import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import {
  ROTULO_DO_STATUS_DO_ITEM,
  statusPermitidosNaFase,
  type FaseDoItem,
} from "@/lib/propostas/status-do-item";
import type { StatusDoItemDaProposta } from "@/lib/propostas/tipos";

/** O que `PATCH /api/v1/proposals/[id]/itens` devolve. */
export interface RespostaDosItens {
  id: string;
  status: string;
  fase: FaseDoItem | null;
  itens: Array<{ id: string; status: StatusDoItemDaProposta }>;
}

const COR_DO_STATUS: Record<StatusDoItemDaProposta, string> = {
  pendente: "border-border bg-muted text-text-muted",
  aceito: "border-success/40 bg-success-bg text-success-fg",
  recusado: "border-error/40 bg-error-bg text-error-fg",
  em_producao: "border-warning/40 bg-warning-bg text-warning-fg",
  entregue: "border-info/40 bg-info-bg text-info-fg",
};

interface Props {
  propostaId: string;
  itemId: string;
  status: StatusDoItemDaProposta;
  /** Fase dos itens que o servidor calculou (`fase_dos_itens` do GET). */
  fase: FaseDoItem | null;
  /** Papel e tela permitem mudar? Sem isso, só o selo. */
  podeEditar: boolean;
  onMudou: (resposta: RespostaDosItens) => void;
}

/**
 * O status de UM item da proposta (migration 9261): selo quando não há o que
 * mudar, seletor quando a fase permite. As opções são as da fase — na cotação
 * pendente/aceito/recusado; no pedido aceito/em produção/entregue — e a regra
 * é a mesma do servidor (`lib/propostas/status-do-item.ts`), que confere de novo.
 */
export function StatusDoItem({ propostaId, itemId, status, fase, podeEditar, onMudou }: Props): React.ReactElement {
  const t = useT();
  const [salvando, setSalvando] = useState(false);
  const permitidos = statusPermitidosNaFase(fase);
  const editavel = podeEditar && permitidos.includes(status);

  if (!editavel) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
          COR_DO_STATUS[status],
        )}
      >
        {t(ROTULO_DO_STATUS_DO_ITEM[status])}
      </span>
    );
  }

  async function mudar(para: StatusDoItemDaProposta) {
    if (para === status) return;
    setSalvando(true);
    try {
      const res = await apiClient.patch<{ data: RespostaDosItens }>(`/api/v1/proposals/${propostaId}/itens`, {
        itens: [{ id: itemId, status: para }],
      });
      onMudou(res.data);
    } catch (erro) {
      showApiError(erro);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <select
      aria-label={t("Status do item")}
      className={cn(
        "min-h-9 rounded-md border px-2 text-xs font-medium disabled:opacity-60",
        COR_DO_STATUS[status],
      )}
      value={status}
      disabled={salvando}
      onChange={(e) => void mudar(e.target.value as StatusDoItemDaProposta)}
    >
      {permitidos.map((s) => (
        <option key={s} value={s}>
          {t(ROTULO_DO_STATUS_DO_ITEM[s])}
        </option>
      ))}
    </select>
  );
}
