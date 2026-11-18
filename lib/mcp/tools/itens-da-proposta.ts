/**
 * Ferramentas MCP do STATUS DOS ITENS da proposta (migration 9261).
 *
 *   crm_get_proposal_items          — leitura: os itens da proposta (ou da
 *                                     proposta vigente do negócio) com o status
 *                                     de cada um e a fase em que estão;
 *   crm_update_proposal_items_status — escrita: a resposta do cliente item a
 *                                     item na cotação, e produção/entrega no
 *                                     pedido.
 *
 * A escrita usa a MESMA regra da tela e da API por token
 * (`lib/propostas/mudar-status-dos-itens.ts`): nenhuma porta repete a fase,
 * a trava otimista, o desfecho da proposta ou o valor do negócio.
 *
 * ESCOPO DA CONVERSA. Com `ctx.contatoDoTurno` (contexto de confiança que o
 * runtime injeta, nunca o modelo), a proposta tem de ser do contato desta
 * conversa — senão a recusa sai ANTES de qualquer dado: itens e preços de um
 * cliente não vão para o WhatsApp de outro. Sem ele (MCP externo, rota HTTP),
 * vale qualquer proposta da organização, como nas demais ferramentas.
 */
import { z } from "zod";

import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { mudarStatusDosItens } from "@/lib/propostas/mudar-status-dos-itens";
import { ROTULO_DO_STATUS_DO_ITEM, faseDoItem } from "@/lib/propostas/status-do-item";
import { calcularTotal } from "@/lib/propostas/total";
import { STATUS_DO_ITEM_DA_PROPOSTA, type StatusDoItemDaProposta } from "@/lib/propostas/tipos";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

const DESLIGADAS = { error: "Propostas estão desligadas nesta organização." } as const;

const FORA_DA_CONVERSA = {
  permitido: false,
  motivo: "fora_da_conversa",
  mensagem:
    "esta proposta é de outra pessoa — os itens de um cliente que não é o desta conversa " +
    "não são seus para ver nem mudar; siga a conversa com quem está falando.",
} as const;

/** Proposta que já saiu de cena: a cancelada e a substituída por uma versão nova. */
const FORA_DE_CENA = ["cancelada", "substituida"];

interface PropostaLida {
  id: string;
  lead_id: string | null;
  contact_id: string | null;
  status: string;
  numero: number | null;
  ano: number | null;
  versao: number;
  total_cents: number;
  moeda: string;
}

const COLUNAS = "id, lead_id, contact_id, status, numero, ano, versao, total_cents, moeda";

async function propostasDesligadas(ctx: McpContext): Promise<boolean> {
  return !(await capacidadesDaOrganizacao(ctx.supabase, ctx.organizationId)).includes("propostas");
}

// ─── leitura ─────────────────────────────────────────────────────────────────

const getItemsInputShape = {
  proposta_id: z
    .string()
    .uuid()
    .optional()
    .describe("A proposta. Sem ele, use lead_id e vem a proposta vigente do negócio."),
  lead_id: z
    .string()
    .uuid()
    .optional()
    .describe("O negócio: devolve a proposta mais recente que não foi cancelada nem substituída."),
};

export const crmGetProposalItems: McpToolDefinition<typeof getItemsInputShape> = {
  name: "crm_get_proposal_items",
  category: "read",
  requiresRole: "viewer",
  requiresScope: "mcp:read",
  description:
    "Lista os produtos (itens) de uma proposta com o status de cada um: pendente, aceito ou " +
    "recusado na cotação; em produção ou entregue no pedido. Use para responder ao cliente o " +
    "que ele já fechou e em que pé está cada item. Informe proposta_id ou lead_id.",
  inputSchema: getItemsInputShape,
  handler: async (input, ctx: McpContext) => {
    if (await propostasDesligadas(ctx)) return DESLIGADAS;
    if (!input.proposta_id && !input.lead_id) return { error: "Informe proposta_id ou lead_id." };

    let proposta: PropostaLida | null = null;
    if (input.proposta_id) {
      const { data } = await ctx.supabase
        .from("crm_proposals")
        .select(COLUNAS)
        .eq("organization_id", ctx.organizationId)
        .eq("id", input.proposta_id)
        .maybeSingle();
      proposta = (data as PropostaLida | null) ?? null;
    } else {
      const { data } = await ctx.supabase
        .from("crm_proposals")
        .select(COLUNAS)
        .eq("organization_id", ctx.organizationId)
        .eq("lead_id", input.lead_id!)
        .order("created_at", { ascending: false })
        .limit(20);
      proposta = ((data ?? []) as PropostaLida[]).find((p) => !FORA_DE_CENA.includes(p.status)) ?? null;
    }
    if (!proposta) return { error: "Proposta não encontrada nesta organização." };
    if (ctx.contatoDoTurno && proposta.contact_id !== ctx.contatoDoTurno) return FORA_DA_CONVERSA;

    let tipoDoDocumento: string | null = null;
    if (proposta.lead_id) {
      const { data: lead } = await ctx.supabase
        .from("crm_leads")
        .select("sales_document_kind")
        .eq("organization_id", ctx.organizationId)
        .eq("id", proposta.lead_id)
        .maybeSingle();
      tipoDoDocumento = (lead as { sales_document_kind: string | null } | null)?.sales_document_kind ?? null;
    }

    const { data: itens, error } = await ctx.supabase
      .from("crm_proposal_items")
      .select("id, descricao, quantidade, preco_unitario_cents, desconto_cents, status")
      .eq("organization_id", ctx.organizationId)
      .eq("proposal_id", proposta.id)
      .order("position", { ascending: true });
    if (error) return { error: "Não foi possível ler os itens agora." };

    return {
      proposta: {
        id: proposta.id,
        numero: proposta.numero !== null ? `${String(proposta.numero).padStart(4, "0")}/${proposta.ano}` : null,
        versao: proposta.versao,
        status: proposta.status,
        total_cents: proposta.total_cents,
        moeda: proposta.moeda,
        fase_dos_itens: faseDoItem(proposta.status, tipoDoDocumento),
      },
      itens: (
        (itens ?? []) as Array<{
          id: string;
          descricao: string;
          quantidade: number;
          preco_unitario_cents: number | null;
          desconto_cents: number;
          status: StatusDoItemDaProposta;
        }>
      ).map((it) => ({
        id: it.id,
        descricao: it.descricao,
        quantidade: it.quantidade,
        preco_unitario_cents: it.preco_unitario_cents,
        total_cents: it.preco_unitario_cents === null ? null : calcularTotal([it]),
        status: it.status,
        status_rotulo: ROTULO_DO_STATUS_DO_ITEM[it.status],
      })),
    };
  },
};

// ─── escrita ─────────────────────────────────────────────────────────────────

const updateStatusInputShape = {
  lead_id: z.string().uuid().describe("O negócio (lead) da proposta — vem do contexto do turno."),
  proposta_id: z
    .string()
    .uuid()
    .optional()
    .describe("A proposta, como crm_get_proposal_items devolve. Sem ele, vale a proposta vigente do negócio."),
  itens: z
    .array(
      z.object({
        id: z.string().uuid().describe("O id do item, como crm_get_proposal_items devolve."),
        status: z.enum(STATUS_DO_ITEM_DA_PROPOSTA),
      }),
    )
    .min(1)
    .max(200),
};

export const crmUpdateProposalItemsStatus: McpToolDefinition<typeof updateStatusInputShape> = {
  name: "crm_update_proposal_items_status",
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  description:
    "Registra o status de itens da proposta. Na cotação (proposta enviada): aceito ou recusado, " +
    "SOMENTE com a confirmação explícita do cliente sobre cada item — nunca deduza. Quando nenhum " +
    "item fica pendente, a proposta é aceita (ou recusada, se todos foram recusados) e o valor do " +
    "negócio passa a ser a soma dos aceitos. No pedido: em_producao e entregue para itens aceitos. " +
    "Leia os itens com crm_get_proposal_items antes.",
  inputSchema: updateStatusInputShape,
  redigirParaAuditoria: (args) => ({ lead_id: args.lead_id, proposta_id: args.proposta_id, itens: args.itens }),
  // Recusa da regra (fora de fase, item de outra proposta, corrida) NÃO é
  // efeito: sem isto o agente diria "registrei" sobre uma escrita que não houve.
  motivoDoVazio: (resultado) =>
    resultado !== null && typeof resultado === "object" && "error" in resultado
      ? String((resultado as { motivo?: string }).motivo ?? "recusado")
      : null,
  handler: async (input, ctx: McpContext) => {
    if (await propostasDesligadas(ctx)) return DESLIGADAS;

    // A proposta é do NEGÓCIO informado — é pelo negócio que o escopo de funil
    // do agente e o do turno (`lead_id: "negocio"`) são conferidos, então uma
    // proposta de outro negócio não pode entrar de carona.
    let proposta: PropostaLida | null = null;
    if (input.proposta_id) {
      const { data } = await ctx.supabase
        .from("crm_proposals")
        .select(COLUNAS)
        .eq("organization_id", ctx.organizationId)
        .eq("id", input.proposta_id)
        .eq("lead_id", input.lead_id)
        .maybeSingle();
      proposta = (data as PropostaLida | null) ?? null;
    } else {
      const { data } = await ctx.supabase
        .from("crm_proposals")
        .select(COLUNAS)
        .eq("organization_id", ctx.organizationId)
        .eq("lead_id", input.lead_id)
        .order("created_at", { ascending: false })
        .limit(20);
      proposta = ((data ?? []) as PropostaLida[]).find((p) => !FORA_DE_CENA.includes(p.status)) ?? null;
    }
    if (!proposta) {
      return { error: "Proposta não encontrada neste negócio.", motivo: "not_found" };
    }
    // O escopo da conversa vem ANTES da escrita: a regra central filtra a
    // organização, mas não sabe de conversa.
    if (ctx.contatoDoTurno && proposta.contact_id !== ctx.contatoDoTurno) return FORA_DA_CONVERSA;

    const saida = await mudarStatusDosItens({
      db: ctx.supabase,
      organizationId: ctx.organizationId,
      actor: ctx.actor,
      apiTokenId: ctx.apiTokenId,
      requestId: ctx.requestId,
      propostaId: proposta.id,
      itens: input.itens,
      via: "mcp",
    });
    if (!saida.ok) {
      return {
        error: saida.message,
        motivo: saida.code,
        ...(saida.details ? { detalhes: saida.details } : {}),
      };
    }
    return {
      proposta_id: saida.resultado.id,
      status_da_proposta: saida.resultado.status,
      fase_dos_itens: saida.resultado.fase,
      itens: saida.resultado.itens,
    };
  },
};
