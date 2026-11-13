/**
 * Leitura de negócios para a integração por token (ERP): o que GET
 * /api/v1/leads, /leads/{id} e /leads/by-external/{source}/{external_id}
 * compartilham.
 *
 * Reaproveita `getLeadHandler` (404 de outra organização e de contato pessoal,
 * prova de meta escondida) e o enriquecimento da tool MCP `crm_get_lead`
 * (nome do dono e da etapa), e acrescenta o nome do funil. Com token o client é
 * o de serviço e ignora a RLS: todo filtro de organização é manual. Com sessão
 * a RLS de `crm_leads` decide o que o usuário enxerga (inclusive o "só os
 * seus"), igual ao quadro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAuthDual, tetoDeEscritaDoToken, type AuthDual } from "@/lib/api/auth-dual";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { ocultarProvaMetaNaResposta } from "@/lib/leads/prova-meta-lead-submitted";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import type { ListLeadsQueryInput } from "@/lib/schemas";

import { idsDeContatosPessoais } from "@/app/api/v1/conversations/_handler";

type SB = SupabaseClient;
type Linha = Record<string, unknown>;

/**
 * Leitura: papel viewer na sessão e no token, escopo `mcp:read`. Por token a
 * leitura conta no teto (balde `leads_leitura`, o mesmo desenho de
 * GET /pipelines): as três rotas de leitura passam por aqui, e rota em
 * PUBLIC_PATHS não tem contagem a montante — um laço de sincronização sem teto
 * martelaria o banco.
 */
export async function resolverAuthDeLeitura(
  req: Parameters<typeof resolveAuthDual>[0],
  requestId: string,
): Promise<AuthDual> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz;
  const tetoEstourado = await tetoDeEscritaDoToken(authz, "leads_leitura", requestId);
  if (tetoEstourado) return { ok: false, response: tetoEstourado };
  return authz;
}

/**
 * Acrescenta às linhas o nome do dono, a etapa `{ id, name }` e o funil
 * `{ id, name }` — uma consulta por tabela, sem N+1. Toda consulta filtra a
 * organização.
 */
export async function enriquecerNegocios(
  supabase: SB,
  organizationId: string,
  leads: Linha[],
): Promise<Linha[]> {
  if (leads.length === 0) return leads;

  const nomes = await nomesDosAtendentes(
    organizationId,
    leads.map((l) => l.owner_user_id as string | null),
  );

  const unicos = (campo: string) => [
    ...new Set(leads.map((l) => l[campo]).filter((id): id is string => Boolean(id))),
  ];

  const etapas = new Map<string, { id: string; name: string }>();
  const etapaIds = unicos("stage_id");
  if (etapaIds.length > 0) {
    const { data } = await supabase
      .from("crm_stages")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("id", etapaIds);
    for (const e of (data ?? []) as Array<{ id: string; name: string }>) etapas.set(e.id, e);
  }

  const funis = new Map<string, { id: string; name: string }>();
  const funilIds = unicos("pipeline_id");
  if (funilIds.length > 0) {
    const { data } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("id", funilIds);
    for (const f of (data ?? []) as Array<{ id: string; name: string }>) funis.set(f.id, f);
  }

  return leads.map((l) => {
    const etapa = l.stage_id ? (etapas.get(l.stage_id as string) ?? null) : null;
    const funil = l.pipeline_id ? (funis.get(l.pipeline_id as string) ?? null) : null;
    return {
      ...l,
      owner_user_name: l.owner_user_id ? (nomes.get(l.owner_user_id as string) ?? null) : null,
      stage: etapa,
      stage_name: etapa?.name ?? null,
      pipeline: funil,
      pipeline_name: funil?.name ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Lista paginada por (updated_at, id) — sincronização incremental
// ---------------------------------------------------------------------------

interface CursorDeSincronia {
  updated_at: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Só os caracteres de um timestamptz: o valor entra num filtro `.or()` do PostgREST. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?$/;

function codificar(p: CursorDeSincronia): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function decodificar(raw: string): CursorDeSincronia | null {
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorDeSincronia>;
    if (typeof p.id !== "string" || !UUID.test(p.id)) return null;
    if (typeof p.updated_at !== "string" || !TIMESTAMP.test(p.updated_at)) return null;
    return { updated_at: p.updated_at, id: p.id };
  } catch {
    return null;
  }
}

export interface ListaDeNegocios {
  leads: Linha[];
  cursor: string | null;
  has_more: boolean;
}

/**
 * Lista negócios em ordem estável (updated_at, id) ascendente. `updated_since`
 * é inclusivo (`>=`): quem sincroniza prefere reler a borda a perdê-la.
 * Negócio de contato pessoal fica fora, como no quadro, ANTES do limite — para
 * cursor e `has_more` descreverem o conjunto visível.
 */
export async function listarNegociosPorAtualizacao(
  supabase: SB,
  ctx: HandlerCtx,
  q: ListLeadsQueryInput,
): Promise<ListaDeNegocios> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);

  let query = supabase
    .from("crm_leads")
    .select("*")
    .eq("organization_id", ctx.organization_id)
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit + 1);

  if (q.pipeline_id) query = query.eq("pipeline_id", q.pipeline_id);
  if (q.stage_id) query = query.eq("stage_id", q.stage_id);
  if (q.status) query = query.eq("status", q.status);
  if (q.owner_user_id) query = query.eq("owner_user_id", q.owner_user_id);
  if (q.source) query = query.eq("source", q.source);
  if (q.external_id) query = query.eq("external_id", q.external_id);
  if (q.updated_since) query = query.gte("updated_at", new Date(q.updated_since).toISOString());

  const pessoais = await idsDeContatosPessoais(supabase, ctx.organization_id);
  if (pessoais.length > 0) {
    query = query.not("contact_id", "in", `(${pessoais.join(",")})`);
  }

  if (q.cursor) {
    const c = decodificar(q.cursor);
    if (!c) {
      throw new ApiError(
        400,
        "invalid_cursor",
        undefined,
        ctx.requestId,
        traduzir("Cursor inválido.", ctx.idioma ?? "pt-BR"),
      );
    }
    query = query.or(`updated_at.gt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.gt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  const rows = (data ?? []) as Linha[];
  const hasMore = rows.length > limit;
  const pagina = hasMore ? rows.slice(0, limit) : rows;
  const ultimo = pagina[pagina.length - 1];
  return {
    leads: pagina.map(ocultarProvaMetaNaResposta),
    cursor: hasMore && ultimo ? codificar({ updated_at: String(ultimo.updated_at), id: String(ultimo.id) }) : null,
    has_more: hasMore,
  };
}
