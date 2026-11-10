import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/consolidado/funil/mover
 *
 * Arrastar um card no FUNIL CONSOLIDADO. O card pode ser de uma empresa que
 * NÃO é a ativa da sessão — e é isso que esta rota existe para resolver: a rota
 * do quadro (`/api/v1/leads/[id]/move`) decide a empresa pelo cookie, e um card
 * de outra empresa daria 404.
 *
 * A empresa vem do PRÓPRIO NEGÓCIO, lido sob RLS (só aparece se a pessoa é
 * membro dela), e precisa estar no escopo da visão. O papel é conferido NESSA
 * empresa (`requireRole("agent", { organizationId })`, papel efetivo do banco),
 * nunca o da empresa ativa: quem é admin numa e leitor noutra não move card da
 * segunda.
 *
 * A escrita é a do `moveLeadHandler` — o caminho de lote, IA, automação e MCP —,
 * com as MESMAS perguntas do quadro: reabertura (#1538), campos exigidos e
 * motivo de ganho (#1536), motivo da perda (#917), contato pessoal (spec 21),
 * mais linha do tempo, evento e auditoria `lead.moved`. Troca de funil continua
 * proibida (P-01): o destino tem de ser etapa do funil do card.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";
import { ocultarProvaMetaNaResposta } from "@/lib/leads/prova-meta-lead-submitted";

export const dynamic = "force-dynamic";

const corpoSchema = z
  .object({
    lead_id: z.string().uuid(),
    stage_id: z.string().uuid(),
    lost_reason: z.string().trim().min(1).max(500).optional(),
    won_reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Corpo inválido.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const input = parsed.data;

  const porta = await abrirVisaoConsolidada(requestId, null);
  if (!porta.ok) return porta.response;
  const { supabase, vinculos, user, t } = porta;

  // Sob RLS: negócio de empresa alheia simplesmente não aparece.
  const { data: lead, error } = await supabase
    .from("crm_leads")
    .select("id, organization_id")
    .eq("id", input.lead_id)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  const daPessoa = lead && vinculos.some((v) => v.organization_id === lead.organization_id);
  if (!lead || !daPessoa) {
    return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  }
  const organizationId = lead.organization_id as string;

  const authz = await requireRole("agent", {
    requestId,
    resource: "crm_leads",
    organizationId,
  });
  if (!authz.ok) return authz.response;

  try {
    const movido = await moveLeadHandler(
      supabase,
      {
        organization_id: organizationId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      input.lead_id,
      {
        to_stage_id: input.stage_id,
        lost_reason: input.lost_reason,
        won_reason: input.won_reason,
      },
    );
    return ok(ocultarProvaMetaNaResposta(movido), { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
