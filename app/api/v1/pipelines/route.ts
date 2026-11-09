import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/pipelines — lista os funis da org ativa (nome + slug), RLS-scoped.
 * Existia só o handler interno (usado pelo MCP); expõe REST pro Select de
 * pipeline do CreateSourceDialog (feature Webhooks).
 *
 * POST /api/v1/pipelines — cria um funil COM as etapas com que ele nasce.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  ETAPAS_INICIAIS,
  posicaoEntre,
  slugDeFunil,
  validarNomeDeFunil,
  type FunilEditavel,
} from "@/lib/pipelines/pipeline-editing";
import { createClient } from "@/lib/supabase/server";
import { conflitoDoBanco, corpo, lerFunis } from "./_funis";
import { listPipelinesHandler } from "./_handler";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * GET — os funis vivos da organização.
 *
 * Aceita sessão (manager+) OU `Bearer dsk_…` com `mcp:read`: um ERP precisa do
 * `pipeline_id` para criar card por `POST /api/v1/leads`, e sem esta leitura a
 * única porta era a tool MCP `crm_list_pipelines`. O token exige o mesmo papel
 * da tool (`agent`), não o da tela — senão a rota REST seria mais dura que a
 * tool que lê exatamente a mesma coisa. A org sai da linha do token, e
 * `listPipelinesHandler` filtra `organization_id` explicitamente (o client do
 * token ignora a RLS).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "pipelines",
    role: "manager",
    scope: "mcp:read",
    tokenRole: "agent",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "pipelines_leitura", requestId);
  if (tetoEstourado) return tetoEstourado;

  try {
    const { pipelines } = await listPipelinesHandler(authz.supabase, {
      organization_id: authz.organizationId,
      actor: authz.actor,
      requestId,
    });
    return ok(pipelines, { requestId });
  } catch {
    return fail("internal_error", t("Falha ao listar funis."), 500, { requestId });
  }
}

// `.max(80)`: o nome é o título de uma linha da lista e o topo do quadro, não um
// parágrafo. O banco não limita, mas a tela quebra muito antes disso.
const bodySchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(280).nullable().optional(),
  })
  .strict();

/** As etapas com que o funil nasce, já com a régua de posição do board. */
function etapasIniciais(orgId: string, pipelineId: string) {
  return ETAPAS_INICIAIS.map((etapa, i) => ({
    organization_id: orgId,
    pipeline_id: pipelineId,
    name: etapa.name,
    slug: etapa.slug,
    position: (i + 1) * 1000,
    is_won: etapa.is_won,
    is_lost: etapa.is_lost,
  }));
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Dê um nome ao funil — é o que aparece na lista."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const name = parsed.data.name.trim();
  const description = parsed.data.description?.trim() || null;

  const supabase = await createClient();

  let funis: FunilEditavel[];
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  // ⚠️ VALIDAR ANTES DE TOCAR O BANCO. O índice único é a rede de segurança, não
  // a primeira linha: um 23505 cru não diz QUAL funil já tem esse nome.
  const veredito = validarNomeDeFunil(name, funis, null);
  if (!veredito.ok) return fail("unprocessable_entity", veredito.erro, 422, { requestId });

  const row = {
    organization_id: orgId,
    name,
    description,
    // Arquivados entram na conta do slug: `uniq_crm_pipelines_org_slug` não é parcial.
    slug: slugDeFunil(name, funis.map((f) => f.slug)),
    // No fim da lista: funil novo aparecendo no meio seria a tela decidindo por
    // quem criou. `lerFunis` vem ordenado.
    position: posicaoEntre(funis[funis.length - 1]?.position ?? null, null),
    // ⚠️ O PRIMEIRO FUNIL DA ORGANIZAÇÃO NASCE PADRÃO. Numa instalação onde o
    // gatilho de seed não rodou, a org fica sem padrão nenhum — e todo lead
    // criado sem funil escolhido não teria para onde ir. `uniq_..._org_default`
    // é parcial, então só os ativos disputam esse lugar.
    is_default: funis.filter((f) => !f.is_archived).length === 0,
  };

  const { data: criado, error } = await supabase
    .from("crm_pipelines")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    const conflito = conflitoDoBanco(error as { code?: string }, name, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }
  const pipelineId = (criado as { id: string }).id;

  const { error: etapasErr } = await supabase
    .from("crm_stages")
    .insert(etapasIniciais(orgId, pipelineId));

  // ⚠️ COMPENSAÇÃO, PORQUE SÃO DUAS ESCRITAS SEM TRANSAÇÃO. Um funil sem etapa é
  // quadro morto: o board abre sem coluna nenhuma, não recebe negócio, e quem
  // criou não tem como saber que aquilo nasceu quebrado. O funil recém-criado
  // ainda não tem negócio, então `crm_leads_pipeline_id_fkey ON DELETE RESTRICT`
  // não atrapalha o desfazimento. A alternativa correta-por-construção seria uma
  // função SQL transacional — que custaria migration + apêndice no baseline para
  // um caso que estas três linhas cobrem.
  if (etapasErr) {
    await supabase
      .from("crm_pipelines")
      .delete()
      .eq("id", pipelineId)
      .eq("organization_id", orgId);
    return fail(
      "internal_error",
      `Não consegui criar as etapas de «${name}». Nada foi salvo — tente de novo.`,
      500,
      { requestId, details: { erro: etapasErr.message } },
    );
  }

  void audit({
    action: "pipeline.created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: pipelineId,
    requestId,
    metadata: { name, slug: row.slug, is_default: row.is_default },
  });

  // Relê em vez de espelhar o que foi pedido: a tela mostra o que o banco tem.
  try {
    const depois = await lerFunis(supabase, orgId);
    return ok(corpo(depois), { status: 201, requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}
