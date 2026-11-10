/**
 * Permissões que a função SDR dá a um membro — cálculo PURO, a única regra.
 *
 * SDR não é papel: é uma função comercial que se soma ao papel do membro
 * (viewer < agent < manager < admin, `lib/auth/types.ts`). A marca mora em
 * `user_organizations.sdr_since` (migration 9252) e só vale quando as quatro
 * condições valem JUNTAS:
 *
 *   1. a organização ligou a função  (`settings.sdr.enabled`)
 *   2. o vínculo está ativo           (`revoked_at` nulo)
 *   3. o papel é agent ou acima       (viewer só olha, não trabalha lead)
 *   4. o membro está marcado          (`sdr_since` preenchido)
 *
 * Consistência por derivação: nenhuma dessas mudanças apaga a marca. Desligar
 * a função, rebaixar para viewer ou revogar o membro tira as permissões na
 * próxima leitura, sem cron e sem limpeza; desfazer a mudança as devolve.
 *
 * Este cálculo NÃO decide acesso a rota — quem decide 401/403 é
 * `requireRole()`. Ele descreve o que o membro pode fazer como SDR, para quem
 * consome (`GET /api/v1/sdr/permissions`).
 */
import { roleAtLeast } from "@/lib/auth/types";
import { ROLES, type Role } from "@/lib/schemas/team";

/** O papel mínimo para ser SDR. */
export const PAPEL_MINIMO_DO_SDR: Role = "agent";

/** Papéis humanos que podem receber a marca, derivados da escada (não redigitados). */
export const PAPEIS_QUE_PODEM_SER_SDR: readonly Role[] = ROLES.filter((r) =>
  roleAtLeast(r, PAPEL_MINIMO_DO_SDR),
);

/**
 * Vocabulário das permissões. Acrescente no fim; nunca renomeie — integrador
 * compara por string.
 *
 * - `sdr.settings.manage`     ligar/desligar a função (admin, mesmo desligada:
 *                             senão ninguém conseguiria ligá-la)
 * - `sdr.assignments.view`    ver quem é SDR (manager+, função ligada)
 * - `sdr.assignments.manage`  marcar/desmarcar SDR (admin, função ligada)
 * - `sdr.leads.prospect`      trabalhar leads de pré-venda (SDR ativo)
 * - `sdr.leads.qualify`       qualificar lead (SDR ativo)
 * - `sdr.leads.handoff`       passar o lead qualificado ao closer (SDR ativo)
 */
export const PERMISSOES_SDR = [
  "sdr.settings.manage",
  "sdr.assignments.view",
  "sdr.assignments.manage",
  "sdr.leads.prospect",
  "sdr.leads.qualify",
  "sdr.leads.handoff",
] as const;
export type PermissaoSdr = (typeof PERMISSOES_SDR)[number];

const PERMISSOES_DO_SDR_ATIVO: readonly PermissaoSdr[] = [
  "sdr.leads.prospect",
  "sdr.leads.qualify",
  "sdr.leads.handoff",
];

/** Por que a marca não está valendo — `null` quando vale. Uma razão só, a primeira que falha. */
export type MotivoSdrInativo =
  | "feature_disabled"
  | "membership_revoked"
  | "role_below_minimum"
  | "not_assigned";

export interface MembroParaPermissao {
  user_id: string;
  role: string;
  revoked_at: string | null;
  sdr_since: string | null;
}

export interface PermissoesDoMembro {
  user_id: string;
  role: string;
  membership_active: boolean;
  sdr: {
    feature_enabled: boolean;
    assigned: boolean;
    assigned_since: string | null;
    active: boolean;
    inactive_reason: MotivoSdrInativo | null;
  };
  /** Ordenadas na ordem de `PERMISSOES_SDR`. */
  permissions: PermissaoSdr[];
}

export function motivoSdrInativo(
  membro: MembroParaPermissao,
  featureEnabled: boolean,
): MotivoSdrInativo | null {
  if (!featureEnabled) return "feature_disabled";
  if (membro.revoked_at !== null) return "membership_revoked";
  if (!roleAtLeast(membro.role, PAPEL_MINIMO_DO_SDR)) return "role_below_minimum";
  if (membro.sdr_since === null) return "not_assigned";
  return null;
}

export function permissoesDoMembro(
  membro: MembroParaPermissao,
  featureEnabled: boolean,
): PermissoesDoMembro {
  const ativo = membro.revoked_at === null;
  const motivo = motivoSdrInativo(membro, featureEnabled);
  const sdrAtivo = motivo === null;

  const concedidas = new Set<PermissaoSdr>();
  if (ativo && roleAtLeast(membro.role, "admin")) concedidas.add("sdr.settings.manage");
  if (ativo && featureEnabled && roleAtLeast(membro.role, "manager")) concedidas.add("sdr.assignments.view");
  if (ativo && featureEnabled && roleAtLeast(membro.role, "admin")) concedidas.add("sdr.assignments.manage");
  if (sdrAtivo) for (const p of PERMISSOES_DO_SDR_ATIVO) concedidas.add(p);

  return {
    user_id: membro.user_id,
    role: membro.role,
    membership_active: ativo,
    sdr: {
      feature_enabled: featureEnabled,
      assigned: membro.sdr_since !== null,
      assigned_since: membro.sdr_since,
      active: sdrAtivo,
      inactive_reason: motivo,
    },
    permissions: PERMISSOES_SDR.filter((p) => concedidas.has(p)),
  };
}
