"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { DestinoDeFunil } from "@/hooks/kanban/useDestinosDeFunil";

/** Uma empresa para onde o negócio pode ir, como `GET /transferir-empresa` devolve. */
export interface EmpresaDeDestino {
  organization_id: string;
  name: string;
  pipelines: DestinoDeFunil[];
}

/**
 * Para quais empresas este negócio pode ser transferido —
 * `GET /api/v1/leads/[id]/transferir-empresa`. Só busca com o diálogo aberto.
 */
export function useDestinosDeEmpresa(leadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["lead", leadId, "transferir-empresa-destinos"],
    queryFn: async () =>
      apiClient.get<{ data: { empresas: EmpresaDeDestino[] } }>(
        `/api/v1/leads/${leadId}/transferir-empresa`,
      ),
    enabled,
    staleTime: 30_000,
    select: (res) => res.data.empresas,
  });
}
