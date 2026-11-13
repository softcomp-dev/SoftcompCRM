/**
 * A EMPRESA NUNCA FICA SEM ADMINISTRADOR — E QUEM GARANTE É O BANCO (migration 9253).
 *
 * As três portas que rebaixam ou revogam (troca de papel da Equipe, revogação
 * de membro, Vínculos do painel do dono) contavam os admins e só depois
 * escreviam. Duas remoções ao mesmo tempo viam cada uma "há outro" e as duas
 * passavam. O gatilho `trg_guarda_ultimo_admin` conta dentro da transação da
 * escrita, sob trava por organização.
 *
 * Cada caso roda numa sessão psql própria, dentro de `begin`: o que ele grava
 * some no fim (rollback explícito ou o fim da sessão depois de um erro).
 *
 * NÃO MEDIDO aqui: duas sessões simultâneas de verdade. A trava
 * (`pg_advisory_xact_lock`) é o que serializa; este arquivo prova a contagem e
 * a recusa, inclusive para um UPDATE que tira dois admins na mesma instrução.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "9253aaaa-0000-4000-8000-000000000001";
const A = "9253bbbb-0000-4000-8000-000000000001";
const B = "9253bbbb-0000-4000-8000-000000000002";
const C = "9253bbbb-0000-4000-8000-000000000003";

/** Monta a organização com os vínculos pedidos e roda `comando` na mesma transação. */
function cenario(vinculos: string, comando: string): string | null {
  try {
    sql(`
      begin;
      insert into auth.users (id, email) values
        ('${A}', 'a-9253@invariant.test'), ('${B}', 'b-9253@invariant.test'), ('${C}', 'c-9253@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'guarda-9253', 'Guarda 9253', 'Guarda 9253')
        on conflict do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ${vinculos};
      ${comando};
      rollback;
    `);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

const aceito = (user: string, role: string) => `('${user}', '${ORG}', '${role}', now())`;
const pendente = (user: string, role: string) => `('${user}', '${ORG}', '${role}', null)`;

describe("o banco recusa tirar o último admin (9253)", () => {
  it("o gatilho existe no baseline — controle positivo da sonda", () => {
    const existe = sql(`
      select count(*) from pg_trigger
       where tgname = 'trg_guarda_ultimo_admin' and tgrelid = 'public.user_organizations'::regclass;
    `).trim();
    expect(existe, "a 9253 não chegou ao baseline").toBe("1");
  });

  it("rebaixar ou revogar o único admin é recusado com ultimo_admin", () => {
    for (const comando of [
      `update public.user_organizations set role = 'agent' where user_id = '${A}' and organization_id = '${ORG}'`,
      `update public.user_organizations set revoked_at = now() where user_id = '${A}' and organization_id = '${ORG}'`,
    ]) {
      expect(cenario(aceito(A, "admin"), comando)).toContain("ultimo_admin");
    }
  });

  it("convite de admin PENDENTE não conta como outro admin", () => {
    const motivo = cenario(
      `${aceito(A, "admin")}, ${pendente(B, "admin")}`,
      `update public.user_organizations set role = 'agent' where user_id = '${A}' and organization_id = '${ORG}'`,
    );
    expect(motivo).toContain("ultimo_admin");
  });

  it("um UPDATE que tira os dois admins de uma vez é recusado inteiro", () => {
    const motivo = cenario(
      `${aceito(A, "admin")}, ${aceito(B, "admin")}`,
      `update public.user_organizations set role = 'agent' where organization_id = '${ORG}'`,
    );
    expect(motivo).toContain("ultimo_admin");
  });

  it("controle: com outro admin aceito, rebaixar passa; e mexer em não-admin é livre", () => {
    expect(
      cenario(
        `${aceito(A, "admin")}, ${aceito(B, "admin")}`,
        `update public.user_organizations set role = 'manager' where user_id = '${A}' and organization_id = '${ORG}'`,
      ),
    ).toBeNull();
    expect(
      cenario(
        `${aceito(A, "admin")}, ${aceito(C, "agent")}`,
        `update public.user_organizations set revoked_at = now() where user_id = '${C}' and organization_id = '${ORG}'`,
      ),
    ).toBeNull();
  });

  it("anon e authenticated não executam a função do gatilho", () => {
    const pode = sql(`
      select has_function_privilege('anon', 'public.fn_guarda_ultimo_admin()', 'execute')::text
          || ',' || has_function_privilege('authenticated', 'public.fn_guarda_ultimo_admin()', 'execute')::text;
    `).trim();
    expect(pode).toBe("false,false");
  });
});
