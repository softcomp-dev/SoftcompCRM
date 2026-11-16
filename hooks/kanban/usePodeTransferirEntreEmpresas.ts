"use client";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { podeTransferirEntreEmpresas } from "@/lib/leads/transferir-entre-empresas";

/**
 * O menu do card oferece "Transferir para outra empresa"? A regra é a pura de
 * `lib/leads/transferir-entre-empresas.ts`; o servidor confere de novo, com o
 * papel lido do banco.
 */
export function usePodeTransferirEntreEmpresas(): boolean {
  const user = useUser();
  const ativa = useActiveOrg();
  return podeTransferirEntreEmpresas({
    empresaAtivaId: ativa?.orgId,
    papelNaAtiva: ativa?.role,
    empresas: user.organizations ?? [],
  });
}
