/**
 * Os negócios que o SDR pode passar ao vendedor — a lista da tela "Leads sem
 * vendedor" (`/app/sdr`, docs/features/sdr.md).
 *
 * A régua é a MESMA da passagem (`recusaDoNegocio` em `./passagem.ts`): negócio
 * ABERTO que está com o próprio SDR ou sem dono humano (na fila ou com um agente
 * de IA). O que esta lista mostra é exatamente o que o botão "Passar" aceita.
 *
 * A leitura usa o client de SESSÃO: a RLS de `crm_leads` decide o que o SDR
 * enxerga, como no quadro. Na visibilidade "só os seus", o atendente SDR vê aqui
 * só os negócios que já estão com ele — a lista não abre nada que o quadro
 * esconda. Ainda assim cada consulta filtra `organization_id` (a organização
 * ativa vem do cookie validado, nunca do corpo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";

import { recusaDoNegocio } from "./passagem";

/** Teto da lista. Passou disso, a resposta avisa (`truncado`) e a tela diz. */
export const LIMITE_DE_NEGOCIOS_DO_SDR = 200;

/** Com quem o negócio está agora. */
export type SituacaoDoNegocio = "comigo" | "ia" | "fila";

export interface NegocioDoSdr {
  id: string;
  title: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
  last_activity_at: string | null;
  pipeline_id: string;
  pipeline_name: string | null;
  stage_id: string;
  stage_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  situacao: SituacaoDoNegocio;
  owner_agent_name: string | null;
}

/** A linha de `crm_leads` como esta lista lê. */
export interface LinhaDoNegocio {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
  last_activity_at: string | null;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  owner_user_id: string | null;
  owner_kind: string | null;
  owner_agent_id: string | null;
}

/** Com quem o negócio está, do ponto de vista do SDR. */
export function situacaoDoNegocio(
  negocio: Pick<LinhaDoNegocio, "owner_user_id" | "owner_kind" | "owner_agent_id">,
  sdrId: string,
): SituacaoDoNegocio {
  if (negocio.owner_user_id === sdrId) return "comigo";
  if (negocio.owner_agent_id !== null || negocio.owner_kind === "ai") return "ia";
  return "fila";
}

export interface NomesDosNegocios {
  funis: ReadonlyMap<string, string>;
  etapas: ReadonlyMap<string, string>;
  contatos: ReadonlyMap<string, string>;
  agentes: ReadonlyMap<string, string>;
}

/**
 * Monta a lista. Pura: descarta o que a passagem recusaria (negócio fechado ou
 * de um colega) e o que está em funil arquivado, e ordena do mais antigo para o
 * mais novo — quem chegou primeiro espera há mais tempo.
 */
export function montarNegociosDoSdr(
  linhas: readonly LinhaDoNegocio[],
  sdrId: string,
  nomes: NomesDosNegocios,
  funisArquivados: ReadonlySet<string> = new Set(),
): NegocioDoSdr[] {
  return linhas
    .filter((l) => recusaDoNegocio(l, sdrId) === null && !funisArquivados.has(l.pipeline_id))
    .map((l) => ({
      id: l.id,
      title: l.title,
      value_cents: l.value_cents,
      currency: l.currency,
      created_at: l.created_at,
      last_activity_at: l.last_activity_at,
      pipeline_id: l.pipeline_id,
      pipeline_name: nomes.funis.get(l.pipeline_id) ?? null,
      stage_id: l.stage_id,
      stage_name: nomes.etapas.get(l.stage_id) ?? null,
      contact_id: l.contact_id,
      contact_name: l.contact_id ? (nomes.contatos.get(l.contact_id) ?? null) : null,
      situacao: situacaoDoNegocio(l, sdrId),
      owner_agent_name: l.owner_agent_id ? (nomes.agentes.get(l.owner_agent_id) ?? null) : null,
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export type ResultadoDaLeitura =
  | { ok: true; negocios: NegocioDoSdr[]; truncado: boolean }
  | { ok: false; mensagem: string };

const COLUNAS_DO_NEGOCIO =
  "id, title, status, value_cents, currency, created_at, last_activity_at, pipeline_id, stage_id, contact_id, owner_user_id, owner_kind, owner_agent_id";

/** Lê do banco e monta a lista. Nunca lança: erro vira `{ ok: false }`. */
export async function carregarNegociosDoSdr(
  db: SupabaseClient,
  opts: { organizationId: string; sdrId: string; t?: (texto: string) => string },
): Promise<ResultadoDaLeitura> {
  const { organizationId, sdrId } = opts;
  try {
    const { data: linhas, error } = await db
      .from("crm_leads")
      .select(COLUNAS_DO_NEGOCIO)
      .eq("organization_id", organizationId)
      .eq("status", "open")
      // `sdrId` é o id do usuário autenticado (um uuid), nunca texto do corpo.
      .or(`owner_user_id.is.null,owner_user_id.eq.${sdrId}`)
      .order("created_at", { ascending: true })
      .limit(LIMITE_DE_NEGOCIOS_DO_SDR + 1);
    if (error) return { ok: false, mensagem: error.message };

    const todas = (linhas ?? []) as LinhaDoNegocio[];
    const truncado = todas.length > LIMITE_DE_NEGOCIOS_DO_SDR;
    const lidas = todas.slice(0, LIMITE_DE_NEGOCIOS_DO_SDR);

    const idsDeFunil = [...new Set(lidas.map((l) => l.pipeline_id))];
    const idsDeEtapa = [...new Set(lidas.map((l) => l.stage_id))];
    const idsDeContato = [...new Set(lidas.map((l) => l.contact_id).filter((c): c is string => c !== null))];
    const idsDeAgente = [...new Set(lidas.map((l) => l.owner_agent_id).filter((a): a is string => a !== null))];

    const [funis, etapas, contatos, agentes] = await Promise.all([
      buscaEmLotes(idsDeFunil, (lote) =>
        db.from("crm_pipelines").select("id, name, is_archived").eq("organization_id", organizationId).in("id", lote),
      ),
      buscaEmLotes(idsDeEtapa, (lote) =>
        db.from("crm_stages").select("id, name").eq("organization_id", organizationId).in("id", lote),
      ),
      buscaEmLotes(idsDeContato, (lote) =>
        db
          .from("contacts")
          .select("id, name, display_name, phone_number, address_book_name")
          .eq("organization_id", organizationId)
          .in("id", lote),
      ),
      buscaEmLotes(idsDeAgente, (lote) =>
        db.from("ai_agents").select("id, name").eq("organization_id", organizationId).in("id", lote),
      ),
    ]);
    // O funil decide o que entra (arquivado sai): leitura que falhou não vira
    // "nenhum arquivado". Os demais nomes são cosméticos e degradam para vazio.
    if (funis.error) return { ok: false, mensagem: funis.error.message };

    const linhasDeFunil = funis.data as Array<{ id: string; name: string; is_archived: boolean }>;
    const nomes: NomesDosNegocios = {
      funis: new Map(linhasDeFunil.map((f) => [f.id, f.name])),
      etapas: new Map((etapas.data as Array<{ id: string; name: string }>).map((e) => [e.id, e.name])),
      contatos: new Map(
        (
          contatos.data as Array<{
            id: string;
            name: string | null;
            display_name: string | null;
            phone_number: string | null;
            address_book_name: string | null;
          }>
        ).map((c) => [c.id, rotuloParaAEquipe(c, opts.t)]),
      ),
      agentes: new Map((agentes.data as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])),
    };
    const arquivados = new Set(linhasDeFunil.filter((f) => f.is_archived).map((f) => f.id));

    return { ok: true, negocios: montarNegociosDoSdr(lidas, sdrId, nomes, arquivados), truncado };
  } catch (erro) {
    return { ok: false, mensagem: erro instanceof Error ? erro.message : String(erro) };
  }
}
