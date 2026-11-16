/**
 * Semente do módulo Contatos: cinco cadastros que a base (as 12 conversas da
 * Inbox) não tem e que as lições fotografam — um contato vindo do site sem
 * conversa ainda (o ícone "Iniciar conversa"), dois vindos de planilha (filtro
 * de origem), um só com e-mail, um pessoal (filtro "Pessoais") e a mesma
 * Juliana da base cadastrada de novo com o número antigo, sem o nono dígito (a
 * tela de duplicados).
 *
 * Mais três linhas na Timeline da Fernanda (a ficha que a lição abre), presas
 * ao negócio que a base cria para ela.
 *
 * Para a lição de classificação do cliente, negócios GANHOS com `closed_at` em
 * idades diferentes (`be2e…`): o gatilho `trg_crm_lead_ultima_venda` recalcula
 * `contacts.last_won_at` sozinho (a coluna é só do sistema, nunca se grava
 * direto) e a classificação sai dele com os prazos de fábrica (90 e 180 dias):
 * Mariana 25 d e Ricardo 40 d = Ativo; Roberto 130 d e Sandra 100 d =
 * Pré-inativo; Juliana Castro 260 d = Inativo; os demais = Sem compra.
 *
 * E, para a lição do histórico de atendimento, uma interação registrada pela
 * equipe na Fernanda (a ligação de ontem de manhã, `be2f…`), ao lado das
 * conversas que a base já criou (ontem e hoje) e do negócio aberto dela.
 *
 * Só INSERT, com ids fixos `be2c…`/`be2d…`/`be2e…`/`be2f…`; apaga e recria só as
 * próprias linhas. A base já limpa contatos e negócios da organização a cada lição.
 */
import { type Contexto, contatoId, exigir, ha, ontemAs, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const id = (n: number) => `be2c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DIA = 24 * 60;

const CONTATOS = [
  {
    n: 1, name: "Gabriela Duarte", phone_number: "+5511987650021", email: "gabriela.duarte@email.com",
    tags: ["primeira-consulta"], source: "site", criado: 25, atividade: 25 as number | null,
  },
  {
    n: 2, name: "Ricardo Teixeira", phone_number: "+5511987650022", email: "ricardo.teixeira@email.com",
    tags: ["odontologia", "particular"], source: "import_csv", birthdate: "1978-11-02", criado: 40 * DIA, atividade: 9 * DIA,
  },
  {
    n: 3, name: "Sandra Lopes", phone_number: null, email: "sandra.lopes@email.com",
    tags: ["nutricao"], source: "manual", criado: 60 * DIA, atividade: 15 * DIA,
  },
  {
    n: 4, name: "Marcos Prado", phone_number: "+5511987650023", email: null,
    tags: [], source: "manual", is_personal: true, criado: 90 * DIA, atividade: 2 * DIA,
  },
  // a Juliana Castro da base (contatoId(3), +5511987650003) com o número antigo
  {
    n: 5, name: "Juliana Castro Silva", phone_number: "+551187650003", email: "juliana.castro@email.com",
    tags: ["convenio"], source: "import_csv", criado: 120 * DIA, atividade: null,
  },
];

const atividadeId = (n: number) => `be2d0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ganhoId = (n: number) => `be2e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const interacaoId = (n: number) => `be2f0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Última venda ganha de cada contato, em dias atrás: quem decide o selo de classificação. */
const VENDAS = [
  { n: 1, contato: contatoId(1), dias: 25 }, // Mariana: Ativo
  { n: 2, contato: id(2), dias: 40 }, // Ricardo Teixeira: Ativo
  { n: 3, contato: contatoId(2), dias: 130 }, // Roberto Almeida: Pré-inativo
  { n: 4, contato: id(3), dias: 100 }, // Sandra Lopes: Pré-inativo
  { n: 5, contato: contatoId(3), dias: 260 }, // Juliana Castro: Inativo
];

export async function semear({ db, org, pessoa, funil }: Contexto) {
  const ids = CONTATOS.map((c) => id(c.n));
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", ids), "limpar contatos do módulo");
  semErro(
    await db.from("contacts").insert(
      CONTATOS.map(({ n, criado, atividade, ...c }) => ({
        // mesmas chaves em toda linha: no insert em lote, chave ausente vira NULL, não o default
        birthdate: null,
        is_personal: false,
        ...c,
        id: id(n),
        organization_id: org,
        created_at: ha(criado),
        last_activity_at: atividade === null ? null : ha(atividade),
      })),
    ),
    "contatos do módulo",
  );

  // ---------- Timeline da Fernanda ----------
  const negocio = exigir(
    await db.from("crm_leads").select("id").eq("organization_id", org).eq("contact_id", contatoId(5)).limit(1).single(),
    "negócio da Fernanda",
  ) as { id: string };
  const vazio = { performed_by_user_id: null as string | null, reason: null as string | null, payload: {} };
  const ATIVIDADES = [
    // "system", não "ai": atividade de IA exige o lastro da execução (crm_lead_activities_ai_needs_evidence)
    { ...vazio, n: 1, type: "lead_created", source_module: "whatsapp", actor_kind: "system", reason: "Chegou pela primeira mensagem no WhatsApp.", performed_at: ontemAs(16, 4) },
    { ...vazio, n: 2, type: "stage_changed", source_module: "crm", actor_kind: "user", performed_by_user_id: pessoa.helena, reason: "Retorno confirmado para quinta às 9h30 com o Dr. Paulo.", performed_at: ha(124) },
    { ...vazio, n: 3, type: "note", source_module: "crm", actor_kind: "user", performed_by_user_id: pessoa.carlos, payload: { body: "Confirmar com o Dr. Paulo se precisa trocar o curativo no retorno." }, performed_at: ha(110) },
  ];
  semErro(await db.from("crm_lead_activities").delete().eq("organization_id", org).in("id", ATIVIDADES.map((a) => atividadeId(a.n))), "limpar atividades do módulo");
  semErro(
    await db.from("crm_lead_activities").insert(
      ATIVIDADES.map(({ n, ...a }) => ({ ...a, id: atividadeId(n), organization_id: org, lead_id: negocio.id, contact_id: contatoId(5) })),
    ),
    "atividades da Fernanda",
  );

  // ---------- vendas ganhas (classificação do cliente) ----------
  semErro(
    await db.from("crm_leads").delete().eq("organization_id", org).in("id", VENDAS.map((v) => ganhoId(v.n))),
    "limpar vendas do módulo",
  );
  const etapaGanha = exigir(
    await db.from("crm_stages").select("id").eq("pipeline_id", funil.id).eq("is_won", true).limit(1).single(),
    "etapa de ganho",
  ) as { id: string };
  semErro(
    await db.from("crm_leads").insert(
      VENDAS.map((v) => ({
        id: ganhoId(v.n),
        organization_id: org,
        pipeline_id: funil.id,
        stage_id: etapaGanha.id,
        title: demo("Pacote de consultas"),
        contact_id: v.contato,
        value_cents: 90000,
        currency: "BRL",
        status: "won",
        closed_at: ha(v.dias * DIA),
        created_at: ha((v.dias + 7) * DIA),
        position_in_stage: 9000 + v.n * 1000,
      })),
    ),
    "vendas ganhas do módulo",
  );

  // ---------- interação registrada pela equipe (histórico de atendimento) ----------
  semErro(
    await db.from("crm_lead_activities").delete().eq("organization_id", org).in("id", [1].map(interacaoId)),
    "limpar interação do módulo",
  );
  semErro(
    await db.from("crm_lead_activities").insert({
      id: interacaoId(1),
      organization_id: org,
      lead_id: negocio.id,
      contact_id: contatoId(5),
      type: "interaction_logged",
      source_module: "atendimento",
      actor_kind: "user",
      performed_by_user_id: pessoa.helena,
      reason: demo("Liguei do celular para confirmar o retorno de quinta. Ela vai levar o laudo da cirurgia."),
      payload: { channel: "phone", direction: "outbound", outcome: "talked", duration_minutes: 6 },
      performed_at: ontemAs(10, 30),
    }),
    "interação registrada da Fernanda",
  );
}
