-- manifest: Guarda do último admin no banco: gatilho em user_organizations recusa (PT409 ultimo_admin) rebaixar ou revogar o último administrador ATIVO e que aceitou o convite, com trava por organização para fechar a corrida entre duas remoções simultâneas.
--
-- Por que no banco: as três portas que rebaixam ou revogam (troca de papel da
-- Equipe, revogação de membro e Vínculos do painel do dono) contavam os admins
-- e só DEPOIS escreviam. Duas remoções ao mesmo tempo, de dois admins, viam
-- cada uma "há outro" e as duas passavam: a empresa ficava sem administrador.
-- Contar no app não fecha essa janela; a trava por organização dentro da
-- transação da escrita, sim.
--
-- Quem conta como admin: papel admin, vínculo não revogado e convite ACEITO.
-- Um convite de admin pendente não administra nada — antes ele contava, e
-- permitia tirar o último admin de verdade enquanto o convite esperava.
--
-- Só UPDATE: apagar a organização (cascade) e apagar a conta (cascade de
-- auth.users) removem linhas e seguem livres. Nenhum caminho do produto revoga
-- de propósito o último admin; o app já recusava com 409 antes desta guarda,
-- que só passa a valer também na corrida.
--
-- A recusa é a mesma do app: 'ultimo_admin' com errcode PT409 (o código da
-- casa para recusa permanente de estado), que as rotas traduzem em 409.

create or replace function public.fn_guarda_ultimo_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outros integer;
begin
  -- Só interessa quem ERA admin ativo e aceito e deixa de ser.
  if old.role <> 'admin' or old.revoked_at is not null or old.accepted_at is null then
    return new;
  end if;
  if new.role = 'admin' and new.revoked_at is null then
    return new;
  end if;

  -- Trava por organização até o fim da transação: a segunda remoção espera a
  -- primeira terminar e então conta já vendo o que ela gravou.
  perform pg_advisory_xact_lock(hashtextextended('ultimo_admin:' || old.organization_id::text, 0));

  select count(*) into v_outros
    from public.user_organizations uo
   where uo.organization_id = old.organization_id
     and uo.id <> old.id
     and uo.role = 'admin'
     and uo.revoked_at is null
     and uo.accepted_at is not null;

  if v_outros = 0 then
    raise exception 'ultimo_admin'
      using errcode = 'PT409',
            detail  = format('a organização %s ficaria sem administrador', old.organization_id),
            hint    = 'Promova outra pessoa a administrador antes de rebaixar ou revogar esta.';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_guarda_ultimo_admin() from public, anon, authenticated;

drop trigger if exists trg_guarda_ultimo_admin on public.user_organizations;
create trigger trg_guarda_ultimo_admin
  before update of role, revoked_at on public.user_organizations
  for each row
  execute function public.fn_guarda_ultimo_admin();
