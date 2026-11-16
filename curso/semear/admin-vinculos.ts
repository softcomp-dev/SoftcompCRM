/**
 * Semente do módulo Vínculos (Admin): uma conta de exemplo, Beatriz Moreira, em
 * quatro situações diante das empresas da instalação.
 *
 *  - Odonto Sorriso Leve: vínculo ativo, como Agente ("Vinculada").
 *  - FisioVida Reabilitação: convite de Gerente que ela ainda não aceitou ("Convite pendente").
 *  - NutriBem Consultório: foi Agente e perdeu o acesso ("Revogada").
 *  - Studio Movimento Pilates: nunca teve vínculo, e a empresa está suspensa (selo "Suspensa").
 *
 * A Clínica Bem Viver também aparece na lista, sem marca: a Beatriz não trabalha lá.
 * A conta (auth) fica de uma rodada para a outra; os vínculos somem com as empresas, que a
 * base apaga antes de cada lição e esta semente recria pelos ids fixos. Ninguém entra no
 * sistema com ela: a senha é aleatória.
 *
 * ⚠️ `created_at` das empresas fica DEPOIS do da Clínica Bem Viver (ver o aviso de
 * `admin-tenants.ts`), e o convite e o aceite são gravados depois da criação da conta.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";

export const ORG_VINCULOS = {
  odonto: "a5200000-0000-4000-8000-000000000001",
  fisio: "a5200000-0000-4000-8000-000000000002",
  nutri: "a5200000-0000-4000-8000-000000000003",
  pilates: "a5200000-0000-4000-8000-000000000004",
};

const CONTA = { email: "beatriz.moreira@consultoriasaude.com.br", nome: "Beatriz Moreira" };

export async function semear(c: Contexto) {
  const { db } = c;
  const principal = exigir(
    await db.from("organizations").select("created_at").eq("id", c.org).single(),
    "criação da org principal",
  ) as { created_at: string };
  const depois = (min: number) =>
    new Date(Math.min(new Date(principal.created_at).getTime() + min * 60_000, Date.now() - (10 - min) * 1000)).toISOString();

  semErro(await db.from("organizations").delete().in("id", Object.values(ORG_VINCULOS)), "apagar empresas de exemplo");
  semErro(
    await db.from("organizations").insert([
      {
        id: ORG_VINCULOS.odonto, slug: "odonto-sorriso-leve", display_name: "Odonto Sorriso Leve",
        legal_name: "Odonto Sorriso Leve Clínica Odontológica Ltda", cnpj: "23.456.789/0001-10",
        status: "active", onboarded_at: depois(3.5), created_at: depois(3), settings: { plan: "pro" },
      },
      {
        id: ORG_VINCULOS.fisio, slug: "fisiovida-reabilitacao", display_name: "FisioVida Reabilitação",
        legal_name: "FisioVida Fisioterapia e Reabilitação Ltda", cnpj: "34.567.890/0001-21",
        status: "active", onboarded_at: depois(4.5), created_at: depois(4), settings: { plan: "standard" },
      },
      {
        id: ORG_VINCULOS.nutri, slug: "nutribem-consultorio", display_name: "NutriBem Consultório",
        legal_name: "NutriBem Consultório de Nutrição Ltda", cnpj: "12.345.678/0001-95",
        status: "active", onboarded_at: depois(2.5), created_at: depois(2), settings: { plan: "standard" },
      },
      {
        id: ORG_VINCULOS.pilates, slug: "studio-movimento-pilates", display_name: "Studio Movimento Pilates",
        legal_name: "Studio Movimento Pilates e Fisioterapia Ltda", cnpj: "45.678.901/0001-32",
        status: "suspended", suspended_kind: "administrativa", suspended_at: new Date().toISOString(),
        suspended_reason: "Contrato encerrado a pedido da clínica; aguardando a exportação dos dados.",
        suspended_by: c.pessoa.helena,
        onboarded_at: depois(1.5), created_at: depois(1), settings: { plan: "standard" },
      },
    ]),
    "empresas de exemplo",
  );

  const r = await db.auth.admin.listUsers({ perPage: 1000 });
  if (r.error) throw new Error(`listUsers: ${r.error.message}`);
  let id = r.data.users.find((u) => u.email === CONTA.email)?.id;
  if (!id) {
    // senha aleatória: ninguém daqui entra no sistema
    const novo = await db.auth.admin.createUser({
      email: CONTA.email, password: crypto.randomUUID(), email_confirm: true, user_metadata: { full_name: CONTA.nome },
    });
    if (novo.error || !novo.data.user) throw new Error(`createUser ${CONTA.email}: ${novo.error?.message ?? "sem usuário"}`);
    id = novo.data.user.id;
  }

  const agora = new Date().toISOString();
  semErro(
    await db.from("user_organizations").insert([
      { user_id: id, organization_id: ORG_VINCULOS.odonto, role: "agent", invited_at: agora, accepted_at: agora, revoked_at: null },
      // convite que ela ainda não aceitou: a linha existe, mas ela não entra na empresa
      { user_id: id, organization_id: ORG_VINCULOS.fisio, role: "manager", invited_at: agora, accepted_at: null, revoked_at: null },
      // já foi agente da NutriBem e saiu
      { user_id: id, organization_id: ORG_VINCULOS.nutri, role: "agent", invited_at: agora, accepted_at: agora, revoked_at: agora },
    ]),
    "vínculos da Beatriz Moreira",
  );
}
