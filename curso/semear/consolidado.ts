/**
 * Semente do módulo Consolidado (Visão consolidada): a Helena, dona da Clínica
 * Bem Viver, passa a atender também duas unidades da mesma rede.
 *
 *  - Bem Viver Moema: a Helena é gerente. Funil "Pacientes" com uma etapa que as
 *    outras não têm ("Lista de espera"); um negócio ganho e um perdido.
 *  - Bem Viver Campinas: a Helena é agente. Funil "Pacientes" com "Reavaliação",
 *    que a Clínica também tem.
 *  - Clínica Bem Viver (a principal): ganha dois negócios e uma etapa nova só
 *    para a Visão ter colunas com "Existe em 2 de 3 funis".
 *
 * Cada empresa leva contatos e conversas fictícios, para as abas Conversas e
 * Contatos terem o que juntar. O nome da empresa aparece em todo item.
 *
 * A lição "Transferir para outra empresa" também mora neste módulo: ela parte do
 * funil da Clínica (o negócio da Bruna Siqueira) e precisa de uma empresa em que
 * a pessoa seja pelo menos agente, que é a Moema. A base apaga as empresas extras
 * antes de cada lição; `semearEmpresasIrmas` só precisa recriá-las pelos ids fixos.
 *
 * ⚠️ `created_at` das empresas fica DEPOIS do da Clínica Bem Viver (ver o aviso de
 * `admin-tenants.ts`) e o `accepted_at` do vínculo da Helena também: a empresa
 * ativa ao entrar é a de vínculo mais antigo, e tem de continuar sendo a Clínica.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { idiomaDaCaptura } from "../configuracao";

export const ORG_IRMA = {
  moema: "a5100000-0000-4000-8000-000000000001",
  campinas: "a5100000-0000-4000-8000-000000000002",
};

const contatoDe = (n: number) => `a5110000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const negocioDe = (n: number) => `a5120000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const conversaDe = (n: number) => `a5130000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Irma = {
  id: string;
  slug: string;
  nome: string;
  razao: string;
  cnpj: string;
  papel: "manager" | "agent";
  /** Nome da 5ª etapa (a que muda de funil para funil); as duas últimas abertas saem. */
  quintaEtapa: string;
};

const IRMAS: Irma[] = [
  {
    id: ORG_IRMA.moema, slug: "bem-viver-moema", nome: "Bem Viver Moema",
    razao: "Bem Viver Moema Saúde Integrada Ltda", cnpj: "45.123.456/0001-10", papel: "manager",
    quintaEtapa: "Lista de espera",
  },
  {
    id: ORG_IRMA.campinas, slug: "bem-viver-campinas", nome: "Bem Viver Campinas",
    razao: "Bem Viver Campinas Saúde Integrada Ltda", cnpj: "45.123.456/0002-91", papel: "agent",
    quintaEtapa: "Reavaliação",
  },
];

/** Nomes das etapas por posição no funil que o gatilho cria (8 etapas; a 3ª é a de ganho, a 8ª a de perda). */
const ETAPAS_DA_CLINICA = ["Reavaliação", "Alta", "Pós-tratamento"];

/**
 * Nome de etapa no idioma da captura. Sem tradução cadastrada, fica o original em vez de
 * derrubar a semente: `funis.ts` também recria estas empresas, e o nome de etapa delas não
 * aparece em nenhuma foto daquele módulo.
 */
function nomeDaEtapa(nome: string): string {
  try {
    return demo(nome);
  } catch {
    return nome;
  }
}

/** Tira empresas pelo caminho do produto (a cascata de negócios → etapas é RESTRICT). */
async function removerEmpresas(c: Contexto, ids: string[]) {
  const existentes = exigir(
    await c.db.from("organizations").select("id, slug").in("id", ids),
    "empresas irmãs existentes",
  ) as Array<{ id: string; slug: string }>;
  for (const x of existentes) {
    semErro(await c.db.from("cobranca_assinaturas").delete().eq("organization_id", x.id), `assinatura de ${x.slug}`);
    semErro(
      await c.db
        .from("organizations")
        .update({ status: "suspended", suspended_kind: "administrativa", suspended_at: new Date().toISOString() })
        .eq("id", x.id),
      `suspender ${x.slug}`,
    );
    semErro(
      await c.db.rpc("fn_excluir_organizacao", {
        p_org: x.id, p_actor: c.pessoa.helena, p_confirmacao: x.slug, p_motivo: "curso: empresa de exemplo",
      }),
      `excluir ${x.slug}`,
    );
  }
}

/**
 * Cria Moema e Campinas com a Helena como membro ativa e o funil "Pacientes" já
 * com os nomes de etapa da clínica. Devolve, por empresa, o id do funil e o id de
 * cada etapa pelo nome.
 */
export async function semearEmpresasIrmas(c: Contexto) {
  const { db } = c;
  const principal = exigir(
    await db.from("organizations").select("created_at").eq("id", c.org).single(),
    "criação da org principal",
  ) as { created_at: string };
  // um minuto por empresa depois da principal, nunca no futuro
  const depois = (min: number) =>
    new Date(Math.min(new Date(principal.created_at).getTime() + min * 60_000, Date.now() - (10 - min) * 1000)).toISOString();

  await removerEmpresas(c, IRMAS.map((i) => i.id));
  semErro(
    await db.from("organizations").insert(
      IRMAS.map((i, n) => ({
        id: i.id, slug: i.slug, display_name: i.nome, legal_name: i.razao, cnpj: i.cnpj,
        locale: idiomaDaCaptura(), status: "active",
        onboarded_at: depois(n + 1.5), created_at: depois(n + 1), settings: { plan: "standard" },
      })),
    ),
    "empresas irmãs",
  );
  // depois da org principal (accepted_at dela vem do bootstrap): a empresa ativa continua sendo a Clínica
  semErro(
    await db.from("user_organizations").insert(
      IRMAS.map((i) => ({
        user_id: c.pessoa.helena, organization_id: i.id, role: i.papel,
        invited_at: new Date().toISOString(), accepted_at: new Date().toISOString(),
      })),
    ),
    "vínculos da Helena com as empresas irmãs",
  );

  const retorno = new Map<string, { funilId: string; etapas: Map<string, string> }>();
  for (const i of IRMAS) {
    const funil = exigir(
      await db.from("crm_pipelines").select("id").eq("organization_id", i.id).eq("is_default", true).limit(1).single(),
      `funil de ${i.nome}`,
    ) as { id: string };
    semErro(
      await db.from("crm_pipelines").update({ name: demo("Pacientes"), slug: "pacientes" }).eq("id", funil.id),
      `nome do funil de ${i.nome}`,
    );
    const etapas = exigir(
      await db.from("crm_stages").select("id").eq("pipeline_id", funil.id).order("position"),
      `etapas de ${i.nome}`,
    ) as Array<{ id: string }>;
    // 1 Primeiro contato · 2 Consulta agendada · 3 ganho · 4 Retorno · 5 a que muda · 6 e 7 saem · 8 perda
    const nomes: Array<string | null> = [
      "Primeiro contato", "Consulta agendada", "Em tratamento", "Retorno", i.quintaEtapa, null, null, null,
    ];
    const mapa = new Map<string, string>();
    for (const [n, nome] of nomes.entries()) {
      const e = etapas[n];
      if (!e) continue;
      if (n >= 5 && n <= 6) {
        semErro(await db.from("crm_stages").delete().eq("id", e.id), `etapa que sai de ${i.nome}`);
      } else if (nome) {
        semErro(await db.from("crm_stages").update({ name: nomeDaEtapa(nome) }).eq("id", e.id), `etapa ${nome} de ${i.nome}`);
        mapa.set(nome, e.id);
      } else {
        mapa.set("Cancelado", e.id); // a etapa de perda segue com o nome que o gatilho deu
      }
    }
    retorno.set(i.id, { funilId: funil.id, etapas: mapa });
  }
  return retorno;
}

type Negocio = {
  n: number;
  org: string;
  titulo: string;
  etapa: string;
  contato: number;
  reais: number;
  fechado?: "won" | "lost";
};

const CONTATOS: Array<{ n: number; org: string; nome: string; telefone: string; email?: string }> = [
  { n: 1, org: ORG_IRMA.moema, nome: "Daniela Frota", telefone: "+5511987660101", email: "daniela.frota@email.com" },
  { n: 2, org: ORG_IRMA.moema, nome: "Otávio Brandão", telefone: "+5511987660102" },
  { n: 3, org: ORG_IRMA.moema, nome: "Ícaro Fontes", telefone: "+5511987660103", email: "icaro.fontes@email.com" },
  { n: 4, org: ORG_IRMA.moema, nome: "Marta Seabra", telefone: "+5511987660104" },
  { n: 5, org: ORG_IRMA.moema, nome: "Valter Cunha", telefone: "+5511987660105" },
  { n: 6, org: ORG_IRMA.campinas, nome: "Nelson Prado", telefone: "+5519987660106" },
  { n: 7, org: ORG_IRMA.campinas, nome: "Tatiana Mello", telefone: "+5519987660107", email: "tatiana.mello@email.com" },
  { n: 8, org: ORG_IRMA.campinas, nome: "Elisa Marques", telefone: "+5519987660108" },
  { n: 9, org: ORG_IRMA.campinas, nome: "Rômulo Tavares", telefone: "+5519987660109" },
  // na Clínica Bem Viver (a principal)
  { n: 10, org: "", nome: "Bruna Siqueira", telefone: "+5511987660110" },
  { n: 11, org: "", nome: "Teresa Albuquerque", telefone: "+5511987660111", email: "teresa.albuquerque@email.com" },
];

const NEGOCIOS: Negocio[] = [
  { n: 1, org: ORG_IRMA.moema, titulo: "Consulta de nutrição — Daniela Frota", etapa: "Primeiro contato", contato: 1, reais: 260 },
  { n: 2, org: ORG_IRMA.moema, titulo: "Fisioterapia pós-cirúrgica — Otávio Brandão", etapa: "Consulta agendada", contato: 2, reais: 1800 },
  { n: 3, org: ORG_IRMA.moema, titulo: "Avaliação ortodôntica — Ícaro Fontes", etapa: "Lista de espera", contato: 3, reais: 350 },
  { n: 4, org: ORG_IRMA.moema, titulo: "Pacote de 8 sessões de pilates — Marta Seabra", etapa: "Em tratamento", contato: 4, reais: 960, fechado: "won" },
  { n: 5, org: ORG_IRMA.moema, titulo: "Consulta dermatológica — Valter Cunha", etapa: "Cancelado", contato: 5, reais: 300, fechado: "lost" },
  { n: 6, org: ORG_IRMA.campinas, titulo: "Avaliação de fisioterapia — Nelson Prado", etapa: "Primeiro contato", contato: 6, reais: 180 },
  { n: 7, org: ORG_IRMA.campinas, titulo: "Retorno nutricional — Tatiana Mello", etapa: "Retorno", contato: 7, reais: 200 },
  { n: 8, org: ORG_IRMA.campinas, titulo: "Pacote de pilates — Elisa Marques", etapa: "Reavaliação", contato: 8, reais: 1100 },
  { n: 9, org: ORG_IRMA.campinas, titulo: "Clareamento dental — Rômulo Tavares", etapa: "Consulta agendada", contato: 9, reais: 1250 },
  { n: 10, org: "", titulo: "Avaliação odontológica — Bruna Siqueira", etapa: "Consulta agendada", contato: 10, reais: 150 },
  { n: 11, org: "", titulo: "Acompanhamento nutricional — Teresa Albuquerque", etapa: "Em tratamento", contato: 11, reais: 840, fechado: "won" },
];

const CONVERSAS: Array<{ n: number; org: string; contato: number; previa: string; haMin: number }> = [
  { n: 1, org: ORG_IRMA.moema, contato: 1, previa: "Oi! Vocês atendem nutrição às quartas à tarde?", haMin: 25 },
  { n: 2, org: ORG_IRMA.moema, contato: 2, previa: "Obrigado, confirmo a sessão de amanhã às 8h.", haMin: 140 },
  { n: 3, org: ORG_IRMA.moema, contato: 3, previa: "Tem vaga para a avaliação neste mês?", haMin: 310 },
  { n: 4, org: ORG_IRMA.campinas, contato: 6, previa: "Boa tarde, queria marcar uma avaliação de fisioterapia.", haMin: 55 },
  { n: 5, org: ORG_IRMA.campinas, contato: 8, previa: "Posso trocar o horário do pilates de sexta?", haMin: 200 },
  { n: 6, org: ORG_IRMA.campinas, contato: 9, previa: "Qual o valor do clareamento com a limpeza?", haMin: 420 },
];

export async function semear(c: Contexto) {
  const { db, org } = c;
  const irmas = await semearEmpresasIrmas(c);
  const orgDe = (x: { org: string }) => x.org || org;

  // ---------- a Clínica Bem Viver ganha os nomes de etapa que a clínica usa ----------
  // A base só renomeia as 4 primeiras (as 5-7 seguem de loja: "Enviado", "Entregue", "Pós-venda").
  // ponytail: altera linhas da base, como funis.ts; o lugar certo é semear-demonstracao.ts.
  const todas = exigir(
    await db.from("crm_stages").select("id, is_lost").eq("pipeline_id", c.funil.id).order("position"),
    "etapas da Clínica por posição",
  ) as Array<{ id: string; is_lost: boolean }>;
  for (const [i, nome] of ETAPAS_DA_CLINICA.entries()) {
    const e = todas[4 + i];
    if (e && !e.is_lost) semErro(await db.from("crm_stages").update({ name: nomeDaEtapa(nome) }).eq("id", e.id), `etapa ${nome}`);
  }
  const etapasDaClinica = exigir(
    await db.from("crm_stages").select("id, name, is_lost").eq("pipeline_id", c.funil.id).eq("is_archived", false),
    "etapas da Clínica",
  ) as Array<{ id: string; name: string; is_lost: boolean }>;
  const etapaDaClinica = (nome: string) => {
    const e = nome === "Cancelado" ? etapasDaClinica.find((x) => x.is_lost) : etapasDaClinica.find((x) => x.name === nomeDaEtapa(nome));
    if (!e) throw new Error(`etapa "${nome}" não existe no funil da Clínica`);
    return e.id;
  };
  const etapaDe = (o: string, nome: string) => {
    if (o === org) return etapaDaClinica(nome);
    const id = irmas.get(o)?.etapas.get(nome);
    if (!id) throw new Error(`etapa "${nome}" não existe no funil de ${o}`);
    return id;
  };

  // ---------- contatos ----------
  // a base já apagou os contatos da Clínica; as empresas irmãs nasceram agora
  semErro(
    await db.from("contacts").insert(
      CONTATOS.map((x) => ({
        id: contatoDe(x.n), organization_id: orgDe(x), name: x.nome, phone_number: x.telefone, ...(x.email ? { email: x.email } : {}),
        last_activity_at: ha(60 + x.n * 37),
      })),
    ),
    "contatos de exemplo",
  );

  // ---------- negócios ----------
  for (const [i, x] of NEGOCIOS.entries()) {
    const o = orgDe(x);
    const funilId = o === org ? c.funil.id : irmas.get(o)!.funilId;
    const entrou = ha(180 + i * 90);
    semErro(
      await db.from("crm_leads").insert({
        id: negocioDe(x.n), organization_id: o, pipeline_id: funilId, stage_id: etapaDe(o, x.etapa),
        title: demo(x.titulo), contact_id: contatoDe(x.contato), value_cents: x.reais * 100, currency: "BRL",
        status: x.fechado ?? "open", closed_at: x.fechado ? entrou : null,
        lost_reason: x.fechado === "lost" ? "price" : null,
        // depois dos negócios da base na Clínica (posição 1000), na ordem da lista
        position_in_stage: 3000 + i * 1000,
        stage_changed_at: entrou, last_activity_at: entrou, created_at: ha(180 + i * 90 + 1440),
      }),
      `negócio ${x.titulo}`,
    );
  }

  // ---------- conversas: um número por empresa irmã ----------
  const numeros = exigir(
    await db.from("channel_sessions").insert(
      IRMAS.map((i) => ({
        organization_id: i.id, provider: "waha", waha_session_name: `${i.slug}-recepcao`,
        webhook_secret_encrypted: "\\x00", status: "WORKING", display_name: `Recepção ${i.nome}`,
      })),
    ).select("id, organization_id"),
    "números das empresas irmãs",
  ) as Array<{ id: string; organization_id: string }>;
  semErro(
    await db.from("conversations").insert(
      CONVERSAS.map((v) => ({
        id: conversaDe(v.n), organization_id: v.org, contact_id: contatoDe(v.contato),
        channel_session_id: numeros.find((n) => n.organization_id === v.org)!.id, status: "open",
        last_inbound_at: ha(v.haMin), last_message_at: ha(v.haMin), last_message_preview: demo(v.previa),
      })),
    ),
    "conversas de exemplo",
  );
}
