/**
 * GET /api/v1/system/version/latest-release — o botão "Buscar atualização".
 *
 * Pergunta ao GitHub, agora, qual é a última release publicada do repositório
 * que o agente do host segue (`release_repo` do retrato), e compara com a
 * versão instalada que o próprio agente confirmou. Só leitura: não grava em
 * `system_version` (quem escreve ali é o agente, e o "Atualizar agora" segue
 * dependendo dele), não audita e não dispara nada.
 *
 * Só o dono do servidor, como o resto do estado operacional de `../route.ts`.
 * A consulta tem cache de 60 s (`lib/system/conferir-release.ts`), que é o que
 * segura a cota da API do GitHub contra cliques repetidos.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { consultarUltimaRelease } from "@/lib/system/conferir-release";
import {
  newerOfficialRelease,
  runtimeConfirmationSchema,
  runtimeIdentity,
} from "@/lib/system/runtime-identity";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Faça login para continuar.", 401);
  const t = (texto: string) => traduzir(texto, user.idioma);
  if (!user.is_platform_admin) {
    return fail("forbidden", t("Só quem administra o servidor pode buscar atualização."), 403);
  }

  const db = createAdminClient();
  const { data: version, error } = await db
    .from("system_version")
    .select("runtime_confirmation, current_version, agent_last_seen_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    logger.error("[system/version/latest-release] leitura de system_version falhou", { error: error.message });
    return fail("internal_error", t("Não consegui ler o estado da atualização."), 500);
  }

  const observacao = runtimeConfirmationSchema.safeParse(version?.runtime_confirmation);
  const repo = observacao.success ? (observacao.data.release_repo ?? null) : null;
  if (!repo) {
    return fail(
      "state_conflict",
      t(
        "O servidor ainda não informou de onde vêm as releases. A conferência automática continua a cada 5 minutos.",
      ),
      409,
    );
  }

  // A versão instalada é a que o AGENTE confirmou — a mesma régua de `../route.ts`.
  const identidade = runtimeIdentity(version?.runtime_confirmation, version?.agent_last_seen_at, new Date());
  const instalada =
    identidade.status === "legacy" ? (version?.current_version ?? "") : (identidade.base_version ?? "");

  const consulta = await consultarUltimaRelease(repo);
  if (!consulta.ok) {
    if (consulta.motivo === "sem_release") {
      return ok({ repo, latest_release: null, installed_version: instalada || null, newer: false, checked_at: null });
    }
    logger.warn("[system/version/latest-release] GitHub não respondeu", { motivo: consulta.motivo, repo });
    return fail("provedor_indisponivel", t("O GitHub não respondeu agora. Tente de novo em instantes."), 502);
  }

  return ok({
    repo,
    latest_release: consulta.release,
    installed_version: instalada || null,
    // null = não deu para comparar (versão instalada desconhecida ou fora do formato).
    newer: newerOfficialRelease(instalada, consulta.release),
    checked_at: consulta.consultado_em,
  });
}
