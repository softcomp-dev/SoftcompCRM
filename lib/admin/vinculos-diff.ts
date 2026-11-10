/**
 * O que a tela de Vínculos precisa mandar ao servidor quando a pessoa clica em
 * Salvar: a diferença entre o que está gravado e o que está marcado na tela.
 *
 * Puro (sem React, sem rede) para o teste medir a regra sem montar a tela.
 */
import type { Role } from "@/lib/auth/types";

/** Estado de UMA empresa na tela: marcada ou não, e com que papel. */
export interface MarcaDaEmpresa {
  marcada: boolean;
  papel: Role;
}

/** O vínculo gravado (só os ATIVOS contam como "marcada"). */
export interface VinculoGravado {
  organization_id: string;
  role: Role;
  revoked_at: string | null;
}

export interface DiferencaDosVinculos {
  /** Empresas a vincular, agrupadas pelo papel escolhido (um POST por papel). */
  vincular: Map<Role, string[]>;
  /** Empresas que seguem marcadas mas com papel novo (um PATCH cada). */
  trocarPapel: Array<{ organization_id: string; role: Role }>;
  /** Empresas desmarcadas que tinham vínculo ativo (um DELETE cada). */
  desvincular: string[];
}

export function diferencaDosVinculos(
  gravados: readonly VinculoGravado[],
  tela: ReadonlyMap<string, MarcaDaEmpresa>,
): DiferencaDosVinculos {
  const ativos = new Map(
    gravados.filter((v) => !v.revoked_at).map((v) => [v.organization_id, v.role]),
  );
  const vincular = new Map<Role, string[]>();
  const trocarPapel: Array<{ organization_id: string; role: Role }> = [];
  const desvincular: string[] = [];

  for (const [orgId, marca] of tela) {
    const papelGravado = ativos.get(orgId);
    if (marca.marcada && papelGravado === undefined) {
      const lista = vincular.get(marca.papel) ?? [];
      lista.push(orgId);
      vincular.set(marca.papel, lista);
    } else if (marca.marcada && papelGravado !== marca.papel) {
      trocarPapel.push({ organization_id: orgId, role: marca.papel });
    } else if (!marca.marcada && papelGravado !== undefined) {
      desvincular.push(orgId);
    }
  }
  return { vincular, trocarPapel, desvincular };
}

export function totalDeMudancas(d: DiferencaDosVinculos): number {
  let n = d.trocarPapel.length + d.desvincular.length;
  for (const lista of d.vincular.values()) n += lista.length;
  return n;
}
