import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/leads/[id]/transferir-empresa — levar o negócio para OUTRA EMPRESA.
 *
 * Para quem tem acesso a mais de uma empresa. As regras (quem pode, o que vai
 * junto, o que fica) moram em `lib/leads/transferir-entre-empresas.ts`; aqui
 * está a ordem das escritas.
 *
 * ── De onde vem cada empresa ─────────────────────────────────────────────────
 *
 * - A ORIGEM é a do próprio negócio, lido sob RLS (só aparece se a pessoa é
 *   membro dela) — como em `/api/v1/consolidado/funil/mover`. Não é a empresa
 *   ativa do cookie: o card pode vir da visão consolidada.
 * - O DESTINO vem do corpo, e por isso não decide nada sozinho: precisa estar
 *   nos vínculos da pessoa lidos FRESCOS do banco (`abrirVisaoConsolidada`), e o
 *   papel é conferido NESSA empresa por `requireRole(..., { organizationId })`.
 *   Toda leitura e escrita do destino filtra `organization_id` explicitamente e
 *   usa o client do usuário (RLS), nunca o service role.
 *
 * ── A ordem das escritas ─────────────────────────────────────────────────────
 *
 * Como na troca de funil (`../clone/route.ts`), o banco não tem transação entre
 * as escritas, então tudo o que pode recusar é perguntado ANTES da primeira, e a
 * ordem é "destino primeiro":
 *  1. contato no destino (achado pelo telefone/e-mail, ou criado);
 *  2. negócio no destino (`createLeadHandler` — etapa, posição, dono, evento,
 *     auditoria `lead.created`);
 *  3. origem encerrada (`encerraDemanda`, motivo `moved_to_another_pipeline`,
 *     que as métricas não contam como perda).
 * Se a 3 falhar, existe um negócio a mais no destino (visível, corrigível) e a
 * origem segue aberta; na ordem inversa, o negócio sumiria da origem sem
 * sucessor. A rota devolve o erro sem esconder a meia-execução.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { abrirVisaoConsolidada } from "@/lib/consolidado/servidor";
import { encontrarContatoPorEmail } from "@/lib/contacts/conflito-unico";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  recusaDeCamposObrigatorios,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";
import {
  FUNIL_DE_DESTINO_NAO_ENCONTRADO,
  ORIGEM_SEM_ETAPA_DE_PERDA,
  escolheEtapaDeDestino,
  registroDoDestino,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { motivoDaPerdaDaOrigem } from "@/lib/leads/motivo-da-perda";
import { ocultarProvaMetaNaResposta } from "@/lib/leads/prova-meta-lead-submitted";
import {
  COLUNAS_DO_CONTATO_DE_ORIGEM,
  PAPEL_MINIMO_NA_ORIGEM,
  PAPEL_MINIMO_NO_DESTINO,
  contatoParaODestino,
  empresasDeDestino,
  montaPayloadDaTransferencia,
  recusaDaTransferencia,
  type ContatoDaOrigem,
} from "@/lib/leads/transferir-entre-empresas";

export const dynamic = "force-dynamic";

const corpoSchema = z
  .object({
    organization_id: z.string().uuid(),
    pipeline_id: z.string().uuid(),
    stage_id: z.string().uuid().optional(),
  })
  .strict();

interface EtapaNaLista {
  id: string;
  pipeline_id: string;
  name: string;
  position: number | string;
  is_won: boolean;
  is_lost: boolean;
}

type Porta = Extract<Awaited<ReturnType<typeof abrirVisaoConsolidada>>, { ok: true }>;

/** O negócio, lido sob RLS e conferido contra os vínculos da pessoa. */
async function lerOrigem(porta: Porta, leadId: string, requestId: string) {
  const { data, error } = await porta.supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  if (error) return { ok: false as const, response: fail("internal_error", error.message, 500, { requestId }) };
  const lead = data as (OrigemParaClonar & { organization_id: string }) | null;
  if (!lead || !porta.vinculos.some((v) => v.organization_id === lead.organization_id)) {
    return {
      ok: false as const,
      response: fail("not_found", porta.t("Lead não encontrado."), 404, { requestId }),
    };
  }
  return { ok: true as const, lead };
}

/**
 * GET — para quais empresas (e funis, e etapas) este negócio pode ir.
 * Uma chamada por abertura do diálogo. Lista vazia não é erro: a tela explica.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const porta = await abrirVisaoConsolidada(requestId, null);
  if (!porta.ok) return porta.response;
  const origem = await lerOrigem(porta, leadId, requestId);
  if (!origem.ok) return origem.response;
  const origemOrgId = origem.lead.organization_id;

  const authz = await requireRole(PAPEL_MINIMO_NA_ORIGEM, {
    requestId,
    resource: "crm_leads",
    organizationId: origemOrgId,
  });
  if (!authz.ok) return authz.response;

  const empresas = [];
  for (const empresa of empresasDeDestino(porta.vinculos, origemOrgId)) {
    const { pipelines } = await listPipelinesHandler(porta.supabase, {
      organization_id: empresa.organization_id,
      actor: { type: "user", id: porta.user.id },
      requestId,
    });
    const ids = pipelines.map((p) => p.id);
    const { data: etapas, error } =
      ids.length === 0
        ? { data: [] as EtapaNaLista[], error: null }
        : await porta.supabase
            .from("crm_stages")
            .select("id, pipeline_id, name, position, is_won, is_lost")
            .eq("organization_id", empresa.organization_id)
            .in("pipeline_id", ids)
            .eq("is_archived", false)
            .order("position", { ascending: true });
    if (error) return fail("internal_error", error.message, 500, { requestId });

    const porFunil = new Map<string, Omit<EtapaNaLista, "pipeline_id">[]>();
    for (const e of (etapas ?? []) as EtapaNaLista[]) {
      const lista = porFunil.get(e.pipeline_id) ?? [];
      lista.push({
        id: e.id,
        name: e.name,
        position: e.position,
        is_won: e.is_won,
        is_lost: e.is_lost,
      });
      porFunil.set(e.pipeline_id, lista);
    }
    empresas.push({
      organization_id: empresa.organization_id,
      name: empresa.nome,
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        stages: porFunil.get(p.id) ?? [],
      })),
    });
  }

  return ok({ empresas }, { requestId });
}

/** POST — transfere. Ver o cabeçalho para a ordem das escritas. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

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
  const { supabase, user, t } = porta;
  const lido = await lerOrigem(porta, leadId, requestId);
  if (!lido.ok) return lido.response;
  const origem = lido.lead;
  const origemOrgId = origem.organization_id;
  const destinoOrgId = input.organization_id;

  const recusa = recusaDaTransferencia({
    origemOrgId,
    destinoOrgId,
    vinculos: porta.vinculos,
    statusDaOrigem: origem.status,
  });
  if (recusa) return fail(recusa.code, t(recusa.texto), recusa.status, { requestId });

  // O papel EFETIVO de cada lado, do banco, com MFA — a leitura dos vínculos
  // acima só recusa cedo com a frase certa.
  const naOrigem = await requireRole(PAPEL_MINIMO_NA_ORIGEM, {
    requestId,
    resource: "crm_leads",
    organizationId: origemOrgId,
  });
  if (!naOrigem.ok) return naOrigem.response;
  const noDestino = await requireRole(PAPEL_MINIMO_NO_DESTINO, {
    requestId,
    resource: "crm_leads",
    organizationId: destinoOrgId,
  });
  if (!noDestino.ok) return noDestino.response;

  const actor = { type: "user" as const, id: user.id };
  const ctxOrigem: HandlerCtx = { organization_id: origemOrgId, actor, requestId, idioma: user.idioma };
  const ctxDestino: HandlerCtx = { organization_id: destinoOrgId, actor, requestId, idioma: user.idioma };
  const nomeDaOrigem = porta.vinculos.find((v) => v.organization_id === origemOrgId)?.nome ?? null;
  const nomeDoDestino = porta.vinculos.find((v) => v.organization_id === destinoOrgId)?.nome ?? null;

  try {
    // ── PRÉ-VOO: tudo que pode recusar, antes da primeira escrita ───────────
    const { data: funil, error: funilErr } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("id", input.pipeline_id)
      .eq("organization_id", destinoOrgId)
      .maybeSingle();
    if (funilErr) return fail("internal_error", funilErr.message, 500, { requestId });
    if (!funil) {
      return fail("pipeline_not_found", t(FUNIL_DE_DESTINO_NAO_ENCONTRADO), 404, { requestId });
    }

    const { data: etapas, error: etapasErr } = await supabase
      .from("crm_stages")
      .select("id, pipeline_id, position, is_won, is_lost, is_archived")
      .eq("organization_id", destinoOrgId)
      .eq("pipeline_id", input.pipeline_id)
      .eq("is_archived", false)
      .order("position", { ascending: true });
    if (etapasErr) return fail("internal_error", etapasErr.message, 500, { requestId });
    const destino = escolheEtapaDeDestino((etapas ?? []) as EtapaDoFunil[], input.stage_id ?? null);
    if (!destino.ok) return fail(destino.code, t(destino.texto), destino.status, { requestId });

    // A etapa de entrada pode exigir campos; o negócio leva os campos da origem.
    const veredito = validaCamposExigidos({
      lead: { custom_fields: origem.custom_fields ?? {} },
      settingsDoFunil: await settingsDoFunil(supabase, destino.etapa.pipeline_id),
      destino: { stageId: destino.etapa.id, desfecho: null },
      motivoDeGanho: null,
      semAnexosAinda: true,
    });
    if (veredito.faltando.length > 0) {
      const r = recusaDeCamposObrigatorios(veredito.faltando, user.idioma);
      return fail(r.codigo, r.mensagem, 422, { details: { faltando: veredito.faltando }, requestId });
    }

    // A origem precisa ter onde fechar (mesmo motivo da troca de funil).
    const { data: etapaDePerda, error: perdaErr } = await supabase
      .from("crm_stages")
      .select("id")
      .eq("organization_id", origemOrgId)
      .eq("pipeline_id", origem.pipeline_id)
      .eq("is_lost", true)
      .eq("is_archived", false)
      .limit(1)
      .maybeSingle();
    if (perdaErr) return fail("internal_error", perdaErr.message, 500, { requestId });
    if (!etapaDePerda) {
      return fail("pipeline_no_lost_stage", t(ORIGEM_SEM_ETAPA_DE_PERDA), 422, { requestId });
    }

    // ── 1. O CONTATO NO DESTINO ─────────────────────────────────────────────
    let contatoNoDestinoId: string | null = null;
    let contatoCriado = false;
    if (origem.contact_id) {
      const { data: contato, error: contatoErr } = await supabase
        .from("contacts")
        .select(COLUNAS_DO_CONTATO_DE_ORIGEM)
        .eq("id", origem.contact_id)
        .eq("organization_id", origemOrgId)
        .maybeSingle();
      if (contatoErr) return fail("internal_error", contatoErr.message, 500, { requestId });
      if (contato) {
        const c = contato as unknown as ContatoDaOrigem;
        const existente =
          (c.phone_number
            ? await encontrarContatoPorTelefone(supabase, destinoOrgId, c.phone_number)
            : null) ?? (c.email ? await encontrarContatoPorEmail(supabase, destinoOrgId, c.email) : null);
        if (existente) {
          contatoNoDestinoId = existente.id;
        } else {
          try {
            const criado = await createContactHandler(
              supabase,
              ctxDestino,
              contatoParaODestino(c, origemOrgId),
            );
            contatoNoDestinoId = criado.contact.id;
            contatoCriado = true;
          } catch (err) {
            // Corrida com outro cadastro do mesmo cliente: o 409 nomeia o contato.
            const id = (err as ApiError)?.details as { contact_id?: string } | undefined;
            if (err instanceof ApiError && err.code === "contact_exists" && id?.contact_id) {
              contatoNoDestinoId = id.contact_id;
            } else {
              throw err;
            }
          }
        }
      }
    }

    // ── 2. O NEGÓCIO NO DESTINO ─────────────────────────────────────────────
    const novo = await createLeadHandler(
      supabase,
      ctxDestino,
      montaPayloadDaTransferencia(origem, destino.etapa, contatoNoDestinoId, origemOrgId),
    );
    const noDestinoDoNovo = registroDoDestino(novo);
    const registro: Record<string, unknown> = { ...noDestinoDoNovo, organization_id: destinoOrgId };
    const novoId = String(noDestinoDoNovo.lead_id);

    const atividade = await emitLeadActivity(supabase, {
      organizationId: destinoOrgId,
      leadId: novoId,
      contactId: contatoNoDestinoId,
      type: "transferred_from_organization",
      sourceModule: "crm",
      sourceId: leadId,
      actor,
      reason: nomeDaOrigem ? `Veio da empresa ${nomeDaOrigem}` : "Veio de outra empresa",
      payload: { from_organization_id: origemOrgId, from_lead_id: leadId },
    });
    if (!atividade.ok) {
      await registraFalhaDeAtividade(supabase, {
        organizationId: destinoOrgId,
        leadId: novoId,
        tipo: "transferred_from_organization",
        origem: "app/api/v1/leads/[id]/transferir-empresa",
        erro: atividade.error,
        requestId,
      });
    }

    // ── 3. A ORIGEM ENCERRA ─────────────────────────────────────────────────
    const motivo = motivoDaPerdaDaOrigem(null);
    const encerrada = await encerraDemanda(supabase, ctxOrigem, {
      leadId,
      desfecho: "lost",
      motivo,
      razaoNaTimeline: nomeDoDestino
        ? `Transferido para a empresa ${nomeDoDestino}`
        : "Transferido para outra empresa",
      payloadNaTimeline: { to_organization_id: destinoOrgId, to_lead_id: novoId },
    });

    const { data: origemFinal, error: updErr } = await supabase
      .from("crm_leads")
      .update({
        source_metadata: { ...(origem.source_metadata ?? {}), transferido_para: registro },
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .eq("organization_id", origemOrgId)
      .select("*")
      .maybeSingle();
    if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

    // Uma linha de auditoria em CADA empresa: cada uma só lê o próprio audit.
    const metadata = {
      actor_type: "user",
      from_organization_id: origemOrgId,
      from_lead_id: leadId,
      to_organization_id: destinoOrgId,
      to_lead_id: novoId,
      to_pipeline_id: input.pipeline_id,
      to_stage_id: destino.etapa.id,
      contact_created: contatoCriado,
      lost_reason: motivo,
    };
    await audit({
      action: "lead.transferred_to_organization",
      actorUserId: user.id,
      organizationId: origemOrgId,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata,
    });
    await audit({
      action: "lead.received_from_organization",
      actorUserId: user.id,
      organizationId: destinoOrgId,
      resourceType: "crm_lead",
      resourceId: novoId,
      requestId,
      metadata,
    });

    return ok(
      {
        lead: novo,
        origem: ocultarProvaMetaNaResposta(
          (origemFinal ?? encerrada.lead ?? origem) as Record<string, unknown>,
        ),
      },
      { requestId, status: 201 },
    );
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
