// hooks/kanban/useItensDaProposta.ts
"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { FaseDoItem } from "@/lib/propostas/status-do-item";
import type { StatusDoItemDaProposta } from "@/lib/propostas/tipos";

export interface ItemDaPropostaNoCard {
  id: string;
  descricao: string;
  quantidade: number;
  preco_unitario_cents: number | null;
  desconto_cents: number;
  status: StatusDoItemDaProposta;
}

export interface PropostaComItens {
  id: string;
  status: string;
  moeda: string;
  total_cents: number;
  fase_dos_itens: FaseDoItem | null;
  itens: ItemDaPropostaNoCard[];
}

/**
 * 9261 — os itens (com status) de UMA proposta, para a tabela do dossiê.
 * Mesma rota do editor (`GET /api/v1/proposals/[id]`); a fase dos itens vem
 * calculada pelo servidor.
 */
export function useItensDaProposta(propostaId: string | null) {
  return useQuery({
    queryKey: ["proposals", "detalhe", propostaId],
    queryFn: async () => apiClient.get<{ data: PropostaComItens }>(`/api/v1/proposals/${propostaId}`),
    enabled: propostaId !== null,
    select: (res) => res.data,
  });
}
