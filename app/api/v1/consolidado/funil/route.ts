/**
 * GET /api/v1/consolidado/funil?empresas=a,b&funil=padrao|<nome>
 *
 * O FUNIL CONSOLIDADO: os funis de várias empresas da pessoa num quadro só, com
 * as etapas de mesmo nome juntadas em uma coluna (`lib/consolidado/colunas.ts`)
 * e a empresa em cada card.
 *
 * Mesmas regras de exibição do quadro de uma empresa
 * (`app/api/v1/pipelines/[id]/board/route.ts`), aplicadas funil a funil:
 * - contato pessoal some (spec 21, etapa 8);
 * - o recorte de encerrados antigos do funil (`ocultar_encerrados_dias`) vale;
 * - `status = archived` não entra.
 *
 * Diferença declarada: o quadro de uma empresa não pagina, este tem TETO por
 * ETAPA (`TETO_DE_NEGOCIOS_POR_ETAPA`, os primeiros pela posição na coluna) e
 * devolve `etapas_truncadas` (e `truncados`, os funis com alguma etapa
 * cortada) — para a tela dizer qual coluna não está completa.
 *
 * Por etapa, e não por funil: `position_in_stage` só ordena DENTRO de uma
 * etapa. Cortar o funil inteiro por ela guardava uma mistura arbitrária das
 * colunas, e uma etapa inteira podia sumir do quadro sem aviso.
 *
 * Toda consulta filtra `organization_id in (escopo)` explicitamente: a RLS é o
 * piso, o escopo da tela é decidido em `lib/consolidado/servidor.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { idsDeContatosPessoais } from "@/app/api/v1/conversations/_handler";
import { fail, ok } from "@/lib/api/wrappers";
import {
  escolherFunis,
  montarColunas,
  nomesDeFunil,
  TETO_DE_NEGOCIOS_POR_ETAPA,
  type EtapaDoFunil,
  type FunilDaEmpresa,
} from "@/lib/consolidado/colunas";
import { emParalelo } from "@/lib/consolidado/em-paralelo";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";
import { diasDeRecorte, recortaEncerradosAntigos } from "@/lib/kanban/recorte-de-encerrados";
import { motivosDoFunil, opcoesDeMotivoDePerda } from "@/lib/leads/motivos-de-perda-do-funil";
import { ROTULO_DO_MOTIVO_CANONICO } from "@/lib/schemas/leads";
import type { Lead } from "@/lib/types/leads";

export const dynamic = "force-dynamic";


interface LinhaDoNegocio {
  id: string;
  organization_id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  title: string;
  status: Lead["status"];
  value_cents: number | null;
  currency: string | null;
  position_in_stage: number;
  updated_at: string;
  closed_at: string | null;
  last_activity_at: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const params = req.nextUrl.searchParams;
  const porta = await abrirVisaoConsolidada(requestId, params.get("empresas"));
  if (!porta.ok) return porta.response;
  const { supabase, escopo, vinculos } = porta;

  const vazio = {
    empresas: vinculos,
    escopo: escopo.map((e) => e.organization_id),
    funis_oferecidos: [],
    funil: "padrao",
    funis: [],
    colunas: [],
    negocios: [],
    truncados: [],
    etapas_truncadas: [],
  };
  if (escopo.length === 0) return ok(vazio, { requestId });
  const orgIds = escopo.map((e) => e.organization_id);

  const { data: funisBrutos, error: funisErr } = await supabase
    .from("crm_pipelines")
    .select("id, organization_id, name, is_default, position, settings")
    .in("organization_id", orgIds)
    .eq("is_archived", false);
  if (funisErr) return fail("internal_error", funisErr.message, 500, { requestId });
  const funisTodos = (funisBrutos ?? []) as Array<
    FunilDaEmpresa & { settings: Record<string, unknown> | null }
  >;

  const oferecidos = nomesDeFunil(funisTodos);
  const pedido = params.get("funil") ?? "padrao";
  const escolha =
    pedido === "padrao" || oferecidos.some((o) => o.chave === pedido) ? pedido : "padrao";
  const funis = escolherFunis(funisTodos, escolha) as typeof funisTodos;
  if (funis.length === 0) {
    return ok({ ...vazio, funis_oferecidos: oferecidos, funil: escolha }, { requestId });
  }
  const funilIds = funis.map((f) => f.id);

  const { data: etapasBrutas, error: etapasErr } = await supabase
    .from("crm_stages")
    .select("id, organization_id, pipeline_id, name, position, is_won, is_lost")
    .in("organization_id", orgIds)
    .in("pipeline_id", funilIds)
    .eq("is_archived", false)
    .order("position");
  if (etapasErr) return fail("internal_error", etapasErr.message, 500, { requestId });
  const etapas = (etapasBrutas ?? []) as EtapaDoFunil[];
  const colunas = montarColunas(etapas);
  const funilPorId = new Map(funis.map((f) => [f.id, f]));

  // Contato pessoal some do quadro — lido UMA vez por empresa, não por etapa.
  const pessoaisPorOrg = new Map<string, readonly string[]>();
  const lidosPessoais = await emParalelo(orgIds, async (org) => {
    pessoaisPorOrg.set(org, await idsDeContatosPessoais(supabase, org));
  }).catch((err: unknown) => err as Error);
  if (lidosPessoais instanceof Error) {
    return fail("internal_error", lidosPessoais.message, 500, { requestId });
  }

  // Uma etapa por consulta, com teto em cada uma: nenhuma coluna cheia empurra
  // as outras para fora do quadro. Etapa arquivada não tem coluna e não é lida.
  const porEtapa = await emParalelo(etapas, async (e) => {
    const { data, error } = await supabase
      .from("crm_leads")
      .select(
        "id, organization_id, pipeline_id, stage_id, contact_id, title, status, value_cents, currency, position_in_stage, updated_at, closed_at, last_activity_at",
      )
      .eq("organization_id", e.organization_id)
      .eq("pipeline_id", e.pipeline_id)
      .eq("stage_id", e.id)
      .neq("status", "archived")
      .order("position_in_stage")
      .order("id")
      .limit(TETO_DE_NEGOCIOS_POR_ETAPA + 1);
    if (error) throw new Error(error.message);
    const linhas = (data ?? []) as LinhaDoNegocio[];
    const pessoais = pessoaisPorOrg.get(e.organization_id) ?? [];
    const visiveis = linhas
      .slice(0, TETO_DE_NEGOCIOS_POR_ETAPA)
      .filter((l) => l.contact_id === null || !pessoais.includes(l.contact_id));
    const funil = funilPorId.get(e.pipeline_id);
    return {
      etapa: e,
      truncado: linhas.length > TETO_DE_NEGOCIOS_POR_ETAPA,
      negocios: recortaEncerradosAntigos(visiveis, diasDeRecorte(funil?.settings ?? null), new Date()),
    };
  }).catch((err: unknown) => err as Error);
  if (porEtapa instanceof Error) {
    return fail("internal_error", porEtapa.message, 500, { requestId });
  }
  const cortadas = porEtapa.filter((p) => p.truncado).map((p) => p.etapa);

  return ok(
    {
      empresas: vinculos,
      escopo: orgIds,
      funis_oferecidos: oferecidos,
      funil: escolha,
      // Os motivos de perda de CADA funil: arrastar para Perdido pede um deles, e
      // o banco confere contra o vocabulário do funil do card.
      funis: funis.map((f) => ({
        id: f.id,
        organization_id: f.organization_id,
        name: f.name,
        motivos_de_perda: opcoesDeMotivoDePerda(motivosDoFunil(f.settings)).map((o) => ({
          valor: o.valor,
          rotulo: o.doFunil
            ? o.valor
            : ((ROTULO_DO_MOTIVO_CANONICO as Record<string, string>)[o.valor] ?? o.valor),
          traduzir: !o.doFunil,
        })),
      })),
      colunas,
      negocios: porEtapa.flatMap((p) => p.negocios),
      truncados: [...new Set(cortadas.map((e) => e.pipeline_id))],
      etapas_truncadas: cortadas.map((e) => e.id),
    },
    { requestId },
  );
}
