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
const NEGOCIOS_KEY = ["sdr", "negocios"] as const;

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

/** O que `GET /api/v1/sdr/vendedores` devolve: se este membro pode passar, e para quem (ids). */
export interface VendedoresDoSdr {
  /** Quem perguntou — o membro logado. */
  user_id: string;
  pode_passar: boolean;
  motivo: string | null;
  vendedores: string[];
}

/**
 * Para quem o membro logado pode passar um negócio. Quem não é SDR recebe
 * `pode_passar: false` (sem 403), e a tela simplesmente não oferece a ação.
 */
export function useVendedoresDoSdr(enabled: boolean) {
  return useQuery({
    queryKey: ["sdr", "vendedores"] as const,
    queryFn: async () =>
      (await apiClient.get<{ data: VendedoresDoSdr }>("/api/v1/sdr/vendedores")).data,
    enabled,
    staleTime: 60_000,
  });
}

/** O que a passagem devolve (`POST /api/v1/leads/[id]/passar-ao-vendedor`). */
export interface ResultadoDaPassagem {
  lead_id: string;
  owner_user_id: string;
  carteira: "passou" | "nao_passou" | "sem_contato";
  carteira_motivo: string | null;
  conversas_passadas: number;
  conversas_que_ficaram: number;
}

/**
 * O SDR passa o negócio ao vendedor que escolheu. O aviso diz o que passou —
 * e, quando o cliente ficou na carteira de outra pessoa, diz isso também, para
 * o SDR não achar que tudo foi junto.
 */
export function usePassarAoVendedor(pipelineId?: string) {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async ({ leadId, userId }: { leadId: string; userId: string; nome: string }) =>
      (
        await apiClient.post<{ data: ResultadoDaPassagem }>(
          `/api/v1/leads/${leadId}/passar-ao-vendedor`,
          { user_id: userId },
        )
      ).data,
    onSuccess: (res, { nome }) => {
      toast.success(t("Negócio passado para {nome}.").replace("{nome}", nome));
      if (res.carteira === "nao_passou") {
        toast.warning(
          t("O cliente continua na carteira de outra pessoa: só o gerente muda a carteira de um colega."),
        );
      }
    },
    onError: (err) => showApiError(err),
    onSettled: () => {
      // Sem funil (a tela Leads sem vendedor), o negócio pode estar em qualquer
      // quadro: invalida todos.
      qc.invalidateQueries({ queryKey: pipelineId ? ["board", pipelineId] : ["board"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: NEGOCIOS_KEY });
    },
  });
}

/** Um negócio da lista `GET /api/v1/sdr/negocios` (`lib/sdr/negocios-do-sdr.ts`). */
export interface NegocioDoSdr {
  id: string;
  title: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
  last_activity_at: string | null;
  pipeline_id: string;
  pipeline_name: string | null;
  stage_id: string;
  stage_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  /** Com quem o negócio está agora: com o SDR, com um agente de IA ou na fila. */
  situacao: "comigo" | "ia" | "fila";
  owner_agent_name: string | null;
}

/**
 * Os negócios que o SDR logado pode passar ao vendedor. Só busca quando ele
 * pode passar (`useVendedoresDoSdr`): para quem não é SDR a rota responde 403.
 */
export function useNegociosDoSdr(enabled: boolean) {
  return useQuery({
    queryKey: NEGOCIOS_KEY,
    queryFn: async () =>
      apiClient.get<{ data: NegocioDoSdr[]; meta?: { total?: number; has_more?: boolean } }>(
        "/api/v1/sdr/negocios",
      ),
    enabled,
    staleTime: 15_000,
  });
}
