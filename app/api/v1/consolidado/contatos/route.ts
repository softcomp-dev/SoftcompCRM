/**
 * GET /api/v1/consolidado/contatos?empresas=a,b&search=…
 *
 * Os contatos de várias empresas da pessoa numa lista só, o de atividade mais
 * recente primeiro, com a empresa de cada um.
 *
 * Cada empresa passa pelo MESMO `listContactsHandler` da tela de Contatos —
 * piso da busca, contato pessoal, mesclados —, com `organization_id` daquela
 * empresa; aqui só se junta. A mesma pessoa cadastrada em duas empresas
 * aparece DUAS vezes, de propósito: são dois registros, com histórico e
 * consentimento próprios (LGPD por controlador), e não se fundem.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { emParalelo } from "@/lib/consolidado/em-paralelo";
import { juntarPorData } from "@/lib/consolidado/juntar";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";

export const dynamic = "force-dynamic";

const POR_EMPRESA = 30;
const LIMITE = 100;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const params = req.nextUrl.searchParams;
  const porta = await abrirVisaoConsolidada(requestId, params.get("empresas"));
  if (!porta.ok) return porta.response;
  const { supabase, escopo, vinculos, user } = porta;
  const search = params.get("search")?.slice(0, 120) || undefined;

  try {
    const listas = await emParalelo(escopo, async (e) => {
      const r = await listContactsHandler(
        supabase,
        {
          organization_id: e.organization_id,
          actor: { type: "user", id: user.id },
          requestId,
          idioma: user.idioma,
        },
        { search, limit: POR_EMPRESA },
      );
      return { organization_id: e.organization_id, itens: r.contacts, tem_mais: r.has_more };
    });
    const { itens, truncado } = juntarPorData(
      listas,
      (c) => {
        const linha = c as { last_activity_at?: string | null; created_at?: string | null };
        return linha.last_activity_at ?? linha.created_at;
      },
      LIMITE,
    );
    return ok(
      { empresas: vinculos, escopo: escopo.map((e) => e.organization_id), contatos: itens },
      { requestId, meta: { has_more: truncado } },
    );
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}
