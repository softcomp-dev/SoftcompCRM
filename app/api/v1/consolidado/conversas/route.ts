/**
 * GET /api/v1/consolidado/conversas?empresas=a,b&search=…&abertas=true
 *
 * As conversas de várias empresas da pessoa numa lista só, a de mensagem mais
 * recente primeiro, com a empresa de cada uma.
 *
 * Cada empresa passa pelo MESMO `listConversationsHandler` da Inbox — contato
 * pessoal escondido, piso da busca, filtros —, com `organization_id` daquela
 * empresa; aqui só se junta (`lib/consolidado/juntar.ts`). Responder exige
 * abrir a conversa na empresa dela: a lista é de leitura, e a tela troca a
 * empresa ativa ao abrir.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { emParalelo } from "@/lib/consolidado/em-paralelo";
import { juntarPorData } from "@/lib/consolidado/juntar";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";
import { listConversationsQuerySchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const POR_EMPRESA = 30;
const LIMITE = 100;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const params = req.nextUrl.searchParams;
  const porta = await abrirVisaoConsolidada(requestId, params.get("empresas"));
  if (!porta.ok) return porta.response;
  const { supabase, escopo, vinculos, user, t } = porta;

  const q = listConversationsQuerySchema.safeParse({
    search: params.get("search") || undefined,
    exclude_finished: params.get("abertas") === "true" ? true : undefined,
    limit: POR_EMPRESA,
  });
  if (!q.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: q.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  try {
    const listas = await emParalelo(escopo, async (e) => {
      const r = await listConversationsHandler(
        supabase,
        {
          organization_id: e.organization_id,
          actor: { type: "user", id: user.id },
          requestId,
          idioma: user.idioma,
        },
        q.data,
      );
      return { organization_id: e.organization_id, itens: r.conversations, tem_mais: r.has_more };
    });
    const { itens, truncado } = juntarPorData(
      listas,
      (c) => (c as { last_message_at?: string | null }).last_message_at,
      LIMITE,
    );
    return ok(
      { empresas: vinculos, escopo: escopo.map((e) => e.organization_id), conversas: itens },
      { requestId, meta: { has_more: truncado } },
    );
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}
