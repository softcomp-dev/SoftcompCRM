/**
 * VÍNCULOS DIRETOS — o dono da instalação liga uma conta que JÁ EXISTE a uma ou
 * mais empresas, sem convite (tela /admin/vinculos).
 *
 * Por que sem convite: o convite existe para provar que o e-mail é de quem vai
 * entrar. Aqui a conta já existe e já provou o e-mail, e quem decide é o dono
 * da instalação — exigir um aceite seria mandar a pessoa clicar num e-mail para
 * receber um acesso que a plataforma já resolveu dar.
 *
 * Este módulo só DECIDE (puro, testado sem banco). Quem escreve é a rota
 * `app/api/v1/admin/users/[id]/vinculos/route.ts`.
 */
import { z } from "zod";
import type { Role } from "@/lib/auth/types";

export const PAPEIS_DO_VINCULO = ["viewer", "agent", "manager", "admin"] as const;

/** Teto por chamada: "marcar todas" numa instalação grande cabe folgado. */
export const TETO_DE_EMPRESAS_POR_CHAMADA = 2000;

export const vincularSchema = z.object({
  organization_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(TETO_DE_EMPRESAS_POR_CHAMADA),
  role: z.enum(PAPEIS_DO_VINCULO),
});

export const trocarPapelSchema = z.object({
  organization_id: z.string().uuid(),
  role: z.enum(PAPEIS_DO_VINCULO),
});

export const desvincularQuerySchema = z.object({
  organization_id: z.string().uuid(),
});

/** A linha de `user_organizations` que a decisão precisa ver. */
export interface VinculoExistente {
  id: string;
  organization_id: string;
  role: Role;
  revoked_at: string | null;
  /** Nulo = convite que a pessoa ainda não aceitou: a linha existe, o acesso não. */
  accepted_at?: string | null;
}

export type PassoDoVinculo =
  /** Nunca esteve na empresa: linha nova. */
  | { tipo: "criar"; organizationId: string }
  /** Esteve e foi revogado: devolve o acesso com o papel escolhido agora. */
  | { tipo: "reativar"; organizationId: string; vinculoId: string; papelAnterior: Role }
  /**
   * Há convite PENDENTE (nunca aceito): o vínculo direto do dono da instalação
   * vale como aceite, com o papel escolhido agora. Tratado como "já ativo", a
   * tela dizia "Vinculada" e a pessoa seguia sem acesso — nada no sistema abre
   * uma empresa para quem não tem `accepted_at`.
   */
  | { tipo: "aceitar"; organizationId: string; vinculoId: string; papelAnterior: Role }
  /** Já está ativo: não mexe — trocar papel tem porta própria (PATCH). */
  | { tipo: "ja_ativo"; organizationId: string; papelAtual: Role }
  /** Empresa que não existe nesta instalação. */
  | { tipo: "empresa_inexistente"; organizationId: string };

/**
 * Para cada empresa pedida, o que fazer. Ids repetidos contam uma vez, na ordem
 * em que apareceram.
 *
 * "Já ativo" não troca o papel de propósito: marcar uma empresa a mais na tela
 * não pode rebaixar em silêncio quem já era admin de outra que estava marcada.
 */
export function planejarVinculos(
  pedidas: readonly string[],
  existentes: readonly VinculoExistente[],
  empresasDaInstalacao: ReadonlySet<string>,
): PassoDoVinculo[] {
  const porOrg = new Map(existentes.map((v) => [v.organization_id, v]));
  const vistos = new Set<string>();
  const passos: PassoDoVinculo[] = [];
  for (const organizationId of pedidas) {
    if (vistos.has(organizationId)) continue;
    vistos.add(organizationId);
    if (!empresasDaInstalacao.has(organizationId)) {
      passos.push({ tipo: "empresa_inexistente", organizationId });
      continue;
    }
    const atual = porOrg.get(organizationId);
    if (!atual) {
      passos.push({ tipo: "criar", organizationId });
    } else if (atual.revoked_at) {
      passos.push({
        tipo: "reativar",
        organizationId,
        vinculoId: atual.id,
        papelAnterior: atual.role,
      });
    } else if (atual.accepted_at === null) {
      passos.push({
        tipo: "aceitar",
        organizationId,
        vinculoId: atual.id,
        papelAnterior: atual.role,
      });
    } else {
      passos.push({ tipo: "ja_ativo", organizationId, papelAtual: atual.role });
    }
  }
  return passos;
}

/**
 * Trocar o papel de alguém pode deixar a empresa sem admin? Só quando a pessoa
 * é admin, deixa de ser, e é a única.
 */
export function rebaixariaUltimoAdmin(
  papelAtual: Role,
  papelNovo: Role,
  adminsAtivosNaEmpresa: number,
): boolean {
  return papelAtual === "admin" && papelNovo !== "admin" && adminsAtivosNaEmpresa <= 1;
}
