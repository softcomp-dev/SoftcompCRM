/**
 * GET /api/v1/admin/vinculos/contas?q=… — busca CONTAS da instalação por e-mail
 * ou nome, para a tela de Vínculos.
 *
 * Não reaproveita `GET /api/v1/admin/users` de propósito: aquela lista nasce de
 * `user_organizations`, então uma conta sem empresa nenhuma não aparece nela — e
 * é justamente a conta que mais precisa de vínculo. Aqui a fonte é o provedor de
 * auth (GoTrue), que conhece toda conta, com ou sem empresa.
 *
 * Só leitura, só o dono da instalação. Devolve no máximo 20 contas; a varredura
 * para em 20 páginas de 1000 (20 mil contas), teto declarado na resposta.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({ q: z.string().trim().min(2).max(120) });
const POR_PAGINA = 1000;
const TETO_DE_PAGINAS = 20;
const MAXIMO_DE_RESULTADOS = 20;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = querySchema.safeParse({ q: req.nextUrl.searchParams.get("q") ?? "" });
  if (!parsed.success) {
    return fail("validation_failed", "Digite ao menos 2 letras.", 422, { requestId });
  }
  const termo = parsed.data.q.toLowerCase();

  const admin = createAdminClient();
  const achadas: Array<{ id: string; email: string | null; full_name: string | null }> = [];
  let truncado = false;
  for (let pagina = 1; pagina <= TETO_DE_PAGINAS; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: pagina, perPage: POR_PAGINA });
    if (error) return fail("internal_error", error.message, 500, { requestId });
    const usuarios = data?.users ?? [];
    for (const u of usuarios) {
      const nome = (u.user_metadata?.full_name as string | undefined) ?? null;
      if (u.email?.toLowerCase().includes(termo) || nome?.toLowerCase().includes(termo)) {
        achadas.push({ id: u.id, email: u.email ?? null, full_name: nome });
        if (achadas.length >= MAXIMO_DE_RESULTADOS) break;
      }
    }
    if (achadas.length >= MAXIMO_DE_RESULTADOS || usuarios.length < POR_PAGINA) break;
    if (pagina === TETO_DE_PAGINAS) truncado = true;
  }

  return ok(achadas, { requestId, meta: { has_more: truncado } });
}
