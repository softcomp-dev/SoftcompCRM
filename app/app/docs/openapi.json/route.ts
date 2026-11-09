/**
 * GET /app/docs/openapi.json — a especificação OpenAPI desta instalação, para a
 * tela `/app/docs` (Swagger).
 *
 * Só para quem está logado (decisão do dono da instalação): o proxy já barra
 * sem sessão, e `requireRole("viewer")` aqui é a validação do lado do servidor
 * que a doutrina pede (`getUser`, nunca o cookie local). Qualquer papel lê —
 * a especificação descreve a API, não dá acesso a ela: cada rota segue
 * exigindo o token e o escopo dela.
 *
 * Mora em `/app/docs/` e não em `/api/v1/`: é um documento para o Swagger (o
 * corpo É a especificação), não um recurso no envelope `{ data }` da API.
 */
import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { especificacaoParaExibir, lerEspecificacao } from "@/lib/api/documentacao";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { marcaDaSaida } from "@/lib/branding/saida";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "api_docs" });
  if (!authz.ok) return authz.response;

  let yaml: string;
  try {
    yaml = await lerEspecificacao();
  } catch (err) {
    // Arquivo fora da imagem é defeito de build (`outputFileTracingIncludes`
    // em next.config.ts), não do usuário: registra para quem opera achar.
    logger.error("docs: especificação OpenAPI não encontrada no disco", {
      requestId,
      error: (err as Error).message,
    });
    return fail("internal_error", "A documentação da API não está disponível nesta instalação.", 500, {
      requestId,
    });
  }

  const marca = await marcaDaSaida(authz.org.orgId);
  const spec = especificacaoParaExibir(yaml, {
    nome: marca.nome,
    origem: env.NEXT_PUBLIC_APP_URL,
  });

  return NextResponse.json(spec, {
    headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
  });
}
