"use client";
/**
 * Hooks da função SDR (docs/features/sdr.md) — a tela de Equipe consome a API
 * de `/api/v1/settings/sdr` e `/api/v1/sdr/assignments`.
 *
 * As permissões NÃO são recalculadas aqui: `active` e `inactive_reason` vêm
 * prontos da lista, calculados por `lib/sdr/permissoes.ts` no servidor.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { MotivoSdrInativo } from "@/lib/sdr/permissoes";

const SDR_KEY = ["sdr"] as const;
const SETTINGS_KEY = ["sdr", "settings"] as const;
const ASSIGNMENTS_KEY = ["sdr", "assignments"] as const;

export interface SdrAssignment {
  user_id: string;
  full_name: string | null;
  role: string;
  assigned_since: string | null;
  active: boolean;
  inactive_reason: MotivoSdrInativo | null;
}

export interface SdrSettings {
  enabled: boolean;
  /** O fluxo que a distribuição automática usa agora (`lib/sdr/distribuicao.ts`). */
  distribution?: { flow: "sdr" | "team"; active_sdrs: number };
}

export function useSdrSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => apiClient.get<{ data: SdrSettings }>("/api/v1/settings/sdr"),
    staleTime: 30_000,
  });
}

/** Só busca com a função ligada: desligada, a rota responde 409 `sdr_disabled`. */
export function useSdrAssignments(opts: { enabled: boolean }) {
  return useQuery({
    queryKey: ASSIGNMENTS_KEY,
    queryFn: async () => apiClient.get<{ data: SdrAssignment[] }>("/api/v1/sdr/assignments"),
    staleTime: 30_000,
    enabled: opts.enabled,
  });
}

export function useToggleSdr() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      apiClient.patch<{ data: { enabled: boolean } }>("/api/v1/settings/sdr", { enabled }),
    onSuccess: (_res, enabled) => {
      toast.success(enabled ? t("Função SDR ligada.") : t("Função SDR desligada."));
    },
    onError: (err) => showApiError(err),
    onSettled: () => qc.invalidateQueries({ queryKey: SDR_KEY }),
  });
}

/** Marca (`assigned: true`) ou desmarca um membro como SDR. */
export function useSetSdr() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async ({ userId, assigned }: { userId: string; assigned: boolean }) =>
      assigned
        ? apiClient.post("/api/v1/sdr/assignments", { user_id: userId })
        : apiClient.delete(`/api/v1/sdr/assignments/${userId}`),
    onSuccess: (_res, { assigned }) => {
      toast.success(assigned ? t("Membro marcado como SDR.") : t("Membro deixou de ser SDR."));
    },
    onError: (err) => showApiError(err),
    // SDR_KEY inteiro: marcar o primeiro SDR (ou desmarcar o último) muda o
    // fluxo da distribuição, que vem no GET do interruptor.
    onSettled: () => qc.invalidateQueries({ queryKey: SDR_KEY }),
  });
}
