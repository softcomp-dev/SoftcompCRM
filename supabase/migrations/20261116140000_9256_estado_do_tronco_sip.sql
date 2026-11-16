-- manifest: Telefonia SIP: `voip_trunk_status` guarda o que o worker de voz fez com o tronco salvo na tela — qual configuração aplicou no Asterisk (hash, sem segredo), quando, se deu erro e se a operadora responde — para a tela de Trunk SIP mostrar o estado em vez de pedir que se cole um bloco no `pjsip.conf`.
--
-- Por quê: até aqui salvar o tronco na tela não mudava nada no servidor — o
-- operador colava o bloco gerado no `asterisk/pjsip.conf` e reiniciava. Agora o
-- worker de voz aplica pela ARI (configuração dinâmica do PJSIP, persistida no
-- astdb) e precisa de um lugar para dizer o que fez.
--
-- Tabela PRÓPRIA, e não colunas em `voip_trunk_settings`: lá o gatilho de
-- `updated_at` marcaria cada conferência do worker como "alguém editou o
-- tronco", e a configuração (escrita por gente) e o estado (escrito pelo
-- servidor) têm donos diferentes. Quem escreve aqui é só `service_role`.
--
-- Idempotente: `create table if not exists`, policy e constraint recriadas.

create table if not exists public.voip_trunk_status (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- SHA-256 da configuração aplicada (inclui a senha CIFRADA, nunca a clara).
  applied_config_hash text,
  applied_at timestamptz,
  state text not null default 'pendente',
  error text,
  checked_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.voip_trunk_status
  drop constraint if exists voip_trunk_status_state_check;
alter table public.voip_trunk_status
  add constraint voip_trunk_status_state_check
  check (state = any (array['pendente', 'erro', 'online', 'offline', 'desligado']));

comment on table public.voip_trunk_status is
  'O que o worker de voz fez com o tronco SIP da organização (aplicação pela ARI e resposta da operadora). Escrito só por service_role.';

alter table public.voip_trunk_status enable row level security;

drop policy if exists voip_trunk_status_select on public.voip_trunk_status;
create policy voip_trunk_status_select on public.voip_trunk_status
  for select using (organization_id in (select public.fn_user_org_ids()));

revoke all on public.voip_trunk_status from anon, authenticated, service_role;
grant select on public.voip_trunk_status to authenticated;
grant select, insert, update, delete on public.voip_trunk_status to service_role;

notify pgrst, 'reload schema';
