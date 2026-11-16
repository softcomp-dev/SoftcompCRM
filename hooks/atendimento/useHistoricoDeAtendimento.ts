"use client";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { HistoricoDeAtendimento } from "@/lib/atendimento/historico";
import type { RegistrarInteracaoInput } from "@/lib/atendimento/interacao-manual";

interface Pagina {
  data: HistoricoDeAtendimento;
  meta?: { cursor?: string | null; has_more?: boolean };
}

export const chaveDoHistorico = (contactId: string) => ["atendimentos", contactId] as const;

/** O histórico de atendimento do contato, página por página (`GET /contacts/[id]/atendimentos`). */
export function useHistoricoDeAtendimento(contactId: string) {
  return useInfiniteQuery({
    queryKey: chaveDoHistorico(contactId),
    enabled: !!contactId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: "30" });
      if (pageParam) qs.set("cursor", pageParam);
      try {
        return await apiClient.get<Pagina>(`/api/v1/contacts/${contactId}/atendimentos?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (ultima) => (ultima.meta?.has_more ? (ultima.meta.cursor ?? undefined) : undefined),
  });
}

export interface PedidoDeRegistro {
  input: RegistrarInteracaoInput;
  /** Uma por abertura do diálogo: o segundo clique no mesmo registro não grava de novo. */
  chave: string;
}

/**
 * Registra a interação feita fora do CRM. Invalida o histórico E a timeline do
 * contato: a linha nova aparece nas duas, e uma só atualizada diria a quem
 * trocar de aba que o registro não pegou.
 */
export function useRegistrarInteracao(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ input, chave }: PedidoDeRegistro) => {
      try {
        return await apiClient.post<{ data: { id: string } }>(
          `/api/v1/contacts/${contactId}/atendimentos`,
          input,
          { idempotencyKey: chave },
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chaveDoHistorico(contactId) });
      void qc.invalidateQueries({ queryKey: ["timeline", contactId] });
    },
  });
}
