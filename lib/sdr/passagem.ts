/**
 * A passagem do SDR para o vendedor — as regras de QUEM pode passar, O QUE pode
 * ser passado e PARA QUEM. Cálculo puro; quem lê o banco e grava é a rota
 * `POST /api/v1/leads/[id]/passar-ao-vendedor`.
 *
 * O SDR qualifica e escolhe, entre os vendedores da equipe, quem fecha. A
 * automação "Atribuir a um atendente" (#3514) já faz a passagem por regra; esta
 * é a passagem por DECISÃO do SDR, negócio a negócio.
 *
 *   quem passa   → SDR ATIVO (a regra única de `permissoes.ts`)
 *   o que passa  → negócio ABERTO que está com o próprio SDR, sem dono humano
 *                  ou com um agente de IA. Tirar o negócio de um colega segue
 *                  sendo do gerente, como na carteira (doc 250).
 *   para quem    → membro ativo, que aceitou o convite, papel agent ou acima,
 *                  que NÃO é SDR ativo e não é o próprio SDR. Passar de SDR
 *                  para SDR é redistribuir pré-venda, e isso é do gerente.
 */
import { roleAtLeast } from "@/lib/auth/types";

import { motivoSdrInativo, type MembroParaPermissao, type MotivoSdrInativo } from "./permissoes";

/** O vínculo como a passagem precisa ler: o da permissão mais o aceite do convite. */
export interface MembroDaPassagem extends MembroParaPermissao {
  accepted_at: string | null;
}

/** O negócio como a passagem precisa ler. */
export interface NegocioDaPassagem {
  status: string;
  owner_user_id: string | null;
}

export type RecusaDoNegocio = "negocio_fechado" | "negocio_de_outro";

export type RecusaDoVendedor =
  | "vendedor_nao_encontrado"
  | "vendedor_inativo"
  | "vendedor_sem_papel"
  | "vendedor_e_voce"
  | "vendedor_e_sdr";

/** Por que este membro não pode passar negócio — `null` quando é SDR ativo. */
export function recusaDoSdr(
  membro: MembroParaPermissao | null,
  funcaoLigada: boolean,
): MotivoSdrInativo | "not_a_member" | null {
  if (!membro) return "not_a_member";
  return motivoSdrInativo(membro, funcaoLigada);
}

/** Por que o SDR não pode passar ESTE negócio — `null` quando pode. */
export function recusaDoNegocio(negocio: NegocioDaPassagem, sdrId: string): RecusaDoNegocio | null {
  if (negocio.status !== "open") return "negocio_fechado";
  if (negocio.owner_user_id !== null && negocio.owner_user_id !== sdrId) return "negocio_de_outro";
  return null;
}

/** Por que este membro não pode receber o negócio do SDR — `null` quando pode. */
export function recusaDoVendedor(
  vendedor: MembroDaPassagem | null,
  sdrId: string,
  funcaoLigada: boolean,
): RecusaDoVendedor | null {
  if (!vendedor) return "vendedor_nao_encontrado";
  if (vendedor.user_id === sdrId) return "vendedor_e_voce";
  if (vendedor.revoked_at !== null || vendedor.accepted_at === null) return "vendedor_inativo";
  if (!roleAtLeast(vendedor.role, "agent")) return "vendedor_sem_papel";
  if (motivoSdrInativo(vendedor, funcaoLigada) === null) return "vendedor_e_sdr";
  return null;
}

/** Os ids de quem o SDR pode escolher, na ordem em que chegaram. */
export function vendedoresParaOSdr(
  equipe: readonly MembroDaPassagem[],
  sdrId: string,
  funcaoLigada: boolean,
): string[] {
  return equipe.filter((m) => recusaDoVendedor(m, sdrId, funcaoLigada) === null).map((m) => m.user_id);
}

/** A frase de cada recusa, canônica em português (a rota traduz). */
export const MENSAGEM_DA_RECUSA: Record<RecusaDoNegocio | RecusaDoVendedor, string> = {
  negocio_fechado: "Este negócio já foi encerrado.",
  negocio_de_outro: "Este negócio está com outra pessoa. Só o gerente tira o negócio de um colega.",
  vendedor_nao_encontrado: "Vendedor não encontrado nesta empresa.",
  vendedor_inativo: "Este vendedor não está ativo na empresa.",
  vendedor_sem_papel: "Este membro tem o papel Somente leitura e não pode receber negócio.",
  vendedor_e_voce: "Escolha outra pessoa: o negócio já está com você.",
  vendedor_e_sdr: "Escolha um vendedor: esta pessoa também é SDR.",
};
