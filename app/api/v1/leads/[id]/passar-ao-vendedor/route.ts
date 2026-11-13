/**
 * POST /api/v1/leads/[id]/passar-ao-vendedor — o SDR passa o negócio ao
 * vendedor que ele escolheu. Corpo: `{ user_id }`.
 *
 * Quem pode, o que pode e para quem: `lib/sdr/passagem.ts` (a regra única).
 * Recusas: 409 `sdr_disabled` (função desligada), 403 `sdr_handoff_forbidden`
 * (quem chamou não é SDR ativo, ou o negócio é de um colega), 404 (negócio de
 * outra empresa ou inexistente), 409 `lead_not_open`, 409 `state_conflict` (o
 * negócio mudou de dono ou foi encerrado no meio da passagem), 422 (vendedor
 * inválido).
 *
 * ─── O que passa, e por qual porta ─────────────────────────────────────────
 *
 * Nenhuma escrita nova: cada pedaço usa a porta que já existe.
 *
 *   1. o NEGÓCIO   → `updateLeadHandler` (a mesma edição do card: valida o
 *                    responsável, grava a linha do tempo, o evento e a auditoria)
 *   2. a CARTEIRA  → `fn_definir_carteira_do_cliente`, com o SDR como ator. A
 *                    função confere a posse dele: passa o cliente que está na
 *                    carteira do SDR ou sem dono com conversa dele; o cliente
 *                    da carteira de um colega fica onde está. A carteira leva
 *                    junto as conversas abertas dela (#3642)
 *   3. as CONVERSAS abertas do contato que seguem com o SDR → `fn_conversation_assign`
 *                    (`transfer`, o botão Transferir), com o negócio já no nome
 *                    do vendedor (`p_negocio_so_sem_dono`)
 *
 * A carteira vem ANTES das conversas: com o cliente sem dono, a posse do SDR é
 * provada justamente pela conversa que está com ele.
 *
 * Se a carteira ou uma conversa não passar, o negócio fica com o vendedor do
 * mesmo jeito e a resposta diz o que ficou para trás — o SDR não precisa
 * adivinhar o que aconteceu.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { logger } from "@/lib/logger";
import { lerFuncaoSdrLigada, listarEquipeDaPassagem } from "@/lib/sdr/atribuicao";
import {
  MENSAGEM_DA_RECUSA,
  recusaDoNegocio,
  recusaDoSdr,
  recusaDoVendedor,
  type NegocioDaPassagem,
} from "@/lib/sdr/passagem";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { updateLeadHandler } from "../../_handler";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({ user_id: z.string().uuid() }).strict();

/** Os estados de conversa que contam como aberta — os mesmos da carteira. */
const CONVERSA_ABERTA = ["open", "pending", "claimed", "ai_handling"] as const;

type Carteira = "passou" | "nao_passou" | "sem_contato";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const idioma = authz.user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const orgId = authz.org.orgId; // do cookie validado, nunca do corpo
  const sdrId = authz.user.id;
  const { id: leadId } = await ctx.params;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", t("Escolha o vendedor."), 422, { requestId });
  }
  const vendedorId = corpo.data.user_id;

  // Admin client: a RLS de `user_organizations` só mostra ao agent o próprio
  // vínculo. Toda consulta abaixo filtra `organization_id` à mão.
  const admin = createAdminClient();

  const funcao = await lerFuncaoSdrLigada(admin, orgId);
  if (!funcao.ok) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });
  if (!funcao.enabled) {
    return fail("sdr_disabled", t("A função SDR está desligada nesta empresa."), 409, { requestId });
  }

  const equipe = await listarEquipeDaPassagem(admin, orgId);
  if (!equipe.ok) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });

  const doSdr = recusaDoSdr(equipe.membros.find((m) => m.user_id === sdrId) ?? null, true);
  if (doSdr !== null) {
    return fail(
      "sdr_handoff_forbidden",
      t("Só um SDR ativo passa o negócio para o vendedor."),
      403,
      { requestId, details: { motivo: doSdr } },
    );
  }

  const doVendedor = recusaDoVendedor(
    equipe.membros.find((m) => m.user_id === vendedorId) ?? null,
    sdrId,
    true,
  );
  if (doVendedor !== null) {
    return fail("validation_failed", t(MENSAGEM_DA_RECUSA[doVendedor]), 422, {
      requestId,
      details: { motivo: doVendedor },
    });
  }

  const { data: lida, error: erroDoNegocio } = await admin
    .from("crm_leads")
    .select("id, status, owner_user_id, contact_id")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (erroDoNegocio) return fail("internal_error", t("Falha ao carregar."), 500, { requestId });
  if (!lida) return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  const negocio = lida as NegocioDaPassagem & { contact_id: string | null };

  const doNegocio = recusaDoNegocio(negocio, sdrId);
  if (doNegocio === "negocio_fechado") {
    return fail("lead_not_open", t(MENSAGEM_DA_RECUSA[doNegocio]), 409, { requestId });
  }
  if (doNegocio === "negocio_de_outro") {
    return fail("sdr_handoff_forbidden", t(MENSAGEM_DA_RECUSA[doNegocio]), 403, {
      requestId,
      details: { motivo: doNegocio },
    });
  }

  const contatoId = negocio.contact_id;
  // As conversas abertas que estão com o SDR AGORA — para saber, no fim, quais
  // foram para o vendedor (pela carteira ou pela transferência abaixo).
  const conversasDoSdr = contatoId ? await conversasCom(admin, orgId, contatoId, sdrId) : [];

  // 1. O negócio, pela mesma edição do card.
  try {
    await updateLeadHandler(
      admin,
      { organization_id: orgId, actor: { type: "user", id: sdrId, role: authz.org.role }, requestId, idioma },
      leadId,
      { owner_user_id: vendedorId },
      // A régua de `recusaDoNegocio` vai também no UPDATE: se outro SDR ou o
      // gerente mexeu no negócio depois da leitura acima, a passagem recusa
      // (409) em vez de sobrescrever o dono que acabou de ser escolhido.
      { somenteSe: { status: "open", owner_user_id: negocio.owner_user_id } },
    );
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }

  // 2. A carteira do cliente, com o SDR como ator: a função confere a posse.
  let carteira: Carteira = "sem_contato";
  let carteiraMotivo: string | null = null;
  if (contatoId) {
    const { error } = await admin.rpc("fn_definir_carteira_do_cliente", {
      p_org: orgId,
      p_actor: sdrId,
      p_contact: contatoId,
      p_dono: vendedorId,
      p_origem: "manual",
    });
    if (error) {
      carteira = "nao_passou";
      carteiraMotivo = motivoDaCarteira(error.message);
      logger.info("[sdr.passagem] a carteira não passou", { lead_id: leadId, motivo: carteiraMotivo });
    } else {
      carteira = "passou";
    }
  }

  // 3. As conversas abertas que a carteira não levou e seguem com o SDR. Pela
  // sessão do SDR, como o botão Transferir.
  const supabase = await createClient();
  const restantes = contatoId ? await conversasCom(admin, orgId, contatoId, sdrId) : [];
  for (const conversaId of restantes) {
    const { error } = await supabase.rpc("fn_conversation_assign", {
      p_organization_id: orgId,
      p_conversation_id: conversaId,
      p_to_user_id: vendedorId,
      p_reason: "transfer",
      p_enforce_expected: false,
      p_negocio_so_sem_dono: true,
    });
    if (error) {
      logger.warn("[sdr.passagem] a conversa não passou", { conversation_id: conversaId, erro: error.message });
    }
  }

  // Quais das conversas que eram do SDR agora estão com o vendedor.
  const doVendedorAgora = contatoId ? new Set(await conversasCom(admin, orgId, contatoId, vendedorId)) : new Set();
  const passadas = conversasDoSdr.filter((id) => doVendedorAgora.has(id));
  const ficaram = conversasDoSdr.length - passadas.length;

  for (const conversaId of passadas) {
    // Avisa o vendedor (o mesmo evento do Transferir) e conta na linha do tempo.
    await supabase
      .rpc("emit_event", {
        p_event_type: "conversation.transferred",
        p_entity_kind: "conversation",
        p_entity_id: conversaId,
        p_payload: { assigned_to_user_id: vendedorId, transferred_by: sdrId },
        p_metadata: { request_id: requestId, origem: "sdr_passagem" },
        p_organization_id: orgId,
      })
      .then(({ error }) => {
        if (error) logger.warn("[sdr.passagem] emit_event falhou", { erro: error.message });
      });
    await registrarTrocaDeComando({
      supabase,
      organizationId: orgId,
      conversationId: conversaId,
      contactId: contatoId,
      tipo: "conversation_transferred",
      actor: { type: "user", id: sdrId, role: authz.org.role },
      motivo: "Passou o cliente para o vendedor",
      payload: { to_user_id: vendedorId },
    });
  }

  const resultado = {
    lead_id: leadId,
    owner_user_id: vendedorId,
    carteira,
    carteira_motivo: carteiraMotivo,
    conversas_passadas: passadas.length,
    conversas_que_ficaram: ficaram,
  };

  await audit({
    action: "sdr.lead_handed_off",
    actorUserId: sdrId,
    organizationId: orgId,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: {
      to_user_id: vendedorId,
      carteira,
      ...(carteiraMotivo ? { carteira_motivo: carteiraMotivo } : {}),
      conversas_passadas: passadas.length,
      conversas_que_ficaram: ficaram,
    },
  });

  return ok(resultado, { requestId });
}

async function conversasCom(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  contatoId: string,
  userId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contatoId)
    .eq("assigned_to_user_id", userId)
    .in("status", [...CONVERSA_ABERTA]);
  return ((data ?? []) as Array<{ id: string }>).map((c) => c.id);
}

/** A recusa da função da carteira, num código que a tela traduz. */
function motivoDaCarteira(mensagem: string): string {
  if (mensagem.includes("carteira_permissao_negada")) return "cliente_de_outro_vendedor";
  if (mensagem.includes("carteira_fora_da_posse")) return "cliente_fora_da_sua_carteira";
  return "erro";
}
