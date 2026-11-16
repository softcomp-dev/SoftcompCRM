/**
 * Semente do módulo "Leads sem vendedor" (função SDR): a clínica ligou a função,
 * a Ana (atendente) é a SDR, e há seis negócios abertos na primeira etapa do funil
 * Pacientes: três com a Ana ("Comigo"), dois sem dono ("Na fila") e um com o
 * agente de IA ("Com a IA"). O Carlos e a Helena não são SDR, então são os dois
 * vendedores que a lista de "Escolha o vendedor" oferece.
 *
 * A lição da tela passa o negócio mais antigo (o 1); a do funil passa o mais novo
 * (o 6), que fica na primeira etapa, visível no quadro.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos) e regrava. A marca de SDR é
 * `user_organizations.sdr_since` e o interruptor é `organizations.settings.sdr.enabled`.
 *
 * ⚠️ O que sobra depois das lições: a marca da Ana em `sdr_since` (a base devolve
 * `organizations.settings` ao estado de fábrica, mas não a coluna do vínculo), por
 * isso `limpar` a zera antes de QUALQUER aula — senão a lição "Ligar a função SDR"
 * de Equipe encontraria a Ana já marcada.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const contatoId = (n: number) => `be800000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const negocioId = (n: number) => `be810000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HORA = 60;
const DIA = 24 * 60;

type Dono = "ana" | "fila" | "ia";
/** [n, título, contato, valor em reais, dono, chegou há (min)] — do mais antigo ao mais novo. */
const NEGOCIOS: ReadonlyArray<readonly [number, string, string, number, Dono, number]> = [
  [1, "Implante dentário — Bruno Teixeira", "Bruno Teixeira", 4500, "ana", 3 * DIA],
  [2, "Pacote de pilates — Camila Duarte", "Camila Duarte", 900, "ana", 2 * DIA],
  [3, "Clareamento dental — Rafael Moura", "Rafael Moura", 1200, "fila", 30 * HORA],
  [4, "Plano de nutrição — Juliana Prado", "Juliana Prado", 1500, "fila", 20 * HORA],
  [5, "Check-up completo — Fábio Lima", "Fábio Lima", 2200, "ia", 6 * HORA],
  [6, "Fisioterapia pós-cirurgia — Marina Costa", "Marina Costa", 1800, "ana", 3 * HORA],
];

const ids = (f: (n: number) => string) => NEGOCIOS.map(([n]) => f(n));

/** Apaga só o que é desta semente e tira a marca de SDR de todo o vínculo da empresa. */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", ids(negocioId)), "limpar negócios do SDR");
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", ids(contatoId)), "limpar contatos do SDR");
  semErro(
    await db.from("user_organizations").update({ sdr_since: null }).eq("organization_id", org).not("sdr_since", "is", null),
    "tirar a marca de SDR",
  );
}

export async function semear(c: Contexto) {
  const { db, org, pessoa, agenteId, funil } = c;
  await limpar(c);

  // ---------- liga a função, preservando o resto de settings ----------
  const atual = exigir(await db.from("organizations").select("settings").eq("id", org).single(), "organização") as {
    settings: Record<string, unknown> | null;
  };
  const settings = atual.settings ?? {};
  const sdr = typeof settings.sdr === "object" && settings.sdr !== null && !Array.isArray(settings.sdr) ? settings.sdr : {};
  semErro(
    await db.from("organizations").update({ settings: { ...settings, sdr: { ...sdr, enabled: true } } }).eq("id", org),
    "ligar a função SDR",
  );

  // ---------- a Ana é a SDR ----------
  semErro(
    await db.from("user_organizations").update({ sdr_since: ha(30 * DIA) }).eq("organization_id", org).eq("user_id", pessoa.ana),
    "marcar a Ana como SDR",
  );

  // ---------- contatos e negócios ----------
  semErro(
    await db.from("contacts").insert(
      NEGOCIOS.map(([n, , nome]) => ({
        id: contatoId(n), organization_id: org, name: nome, phone_number: `+55119876509${String(n).padStart(2, "0")}`,
      })),
    ),
    "contatos do SDR",
  );
  exigir(
    await db.from("crm_leads").insert(
      NEGOCIOS.map(([n, titulo, , reais, dono, minutos]) => ({
        id: negocioId(n), organization_id: org, pipeline_id: funil.id, stage_id: funil.etapas[0]!,
        title: demo(titulo), contact_id: contatoId(n), value_cents: reais * 100, currency: "BRL", status: "open",
        owner_user_id: dono === "ana" ? pessoa.ana : null,
        owner_agent_id: dono === "ia" ? agenteId : null,
        owner_kind: dono === "ana" ? "user" : dono === "ia" ? "ai" : null,
        created_at: ha(minutos),
      })),
    ).select("id"),
    "negócios do SDR",
  );
}
