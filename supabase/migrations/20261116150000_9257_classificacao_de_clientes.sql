-- manifest: **Classificação do cliente por recência de compra (ativo, pré-inativo, inativo).** `contacts` ganha `last_won_at` (fechamento do negócio ganho mais recente do contato, RECALCULADO pelo gatilho `trg_crm_lead_ultima_venda` em `crm_leads` a cada ganho, reabertura, troca de contato ou exclusão — nunca só sobe) e `pre_inativo_avisado_para` (o `last_won_at` para o qual a Central já avisou que o cliente ficou pré-inativo; só o cron escreve). `organizations` ganha `classificacao_ativo_dias` (default 90) e `classificacao_pre_inativo_dias` (default 180), com CHECK 1..3650 e pré-inativo > ativo. A classificação em si é calculada na leitura (`lib/clientes/classificacao.ts`). Guarda `trg_contato_colunas_de_venda`: sessão nenhuma grava as duas colunas. `agent_inbox_items.kind` ganha `client_pre_inactive`. Backfill do `last_won_at` a partir dos negócios ganhos existentes. Idempotente; apêndice espelhado no `baseline.sql`.

-- 9257 — classificação do cliente por recência de compra.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `contacts.last_won_at`: o `closed_at` do negócio GANHO mais recente do
--      contato. É Integrar/Calcular da DIRC materializado num ponto só porque
--      a lista, o filtro e o público de campanha precisam filtrar por ele com
--      índice. A FONTE é `crm_leads`; esta coluna é derivada e quem a mantém é
--      o gatilho — não o código de aplicação, porque um negócio é ganho por
--      vários caminhos (mover de etapa, API, automação, importação).
--   2. O gatilho RECALCULA (max) em vez de subir com `greatest`: um negócio
--      ganho que é reaberto, perdido, apagado ou passado a outro contato tem
--      de deixar de contar. Não faz HTTP.
--   3. `contacts.pre_inativo_avisado_para`: a marca do aviso da Central. O
--      cron só avisa quando ela difere do `last_won_at` atual — um aviso por
--      venda, e um novo quando o cliente compra de novo e volta a esfriar.
--   4. Os dois prazos em colunas de `organizations`, com CHECK (o banco
--      segura a faixa, como em `lembrete_caso_*` da 0766).
--   5. O kind `client_pre_inactive` no CHECK de `agent_inbox_items`.
--
-- A FAIXA (ativo/pré-inativo/inativo) NÃO é gravada: muda com o passar do
-- tempo sem que nada aconteça, e coluna sincronizada por cron é anti-pattern.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `add column if not exists`; CHECKs trocados dentro de bloco DO; `create or
-- replace function`; `drop trigger if exists` + `create trigger`; o backfill só
-- escreve onde o valor difere.

alter table public.contacts
  add column if not exists last_won_at timestamptz,
  add column if not exists pre_inativo_avisado_para timestamptz;

comment on column public.contacts.last_won_at is
  'Fechamento (closed_at) do negócio ganho mais recente do contato. Derivado de crm_leads; mantido por trg_crm_lead_ultima_venda (migration 9257). Base da classificação ativo/pré-inativo/inativo.';
comment on column public.contacts.pre_inativo_avisado_para is
  'last_won_at para o qual a Central já avisou que o cliente ficou pré-inativo (kind client_pre_inactive). Só o cron classificacao-de-clientes escreve (migration 9257).';

create index if not exists idx_contacts_org_last_won
  on public.contacts (organization_id, last_won_at);

alter table public.organizations
  add column if not exists classificacao_ativo_dias smallint not null default 90,
  add column if not exists classificacao_pre_inativo_dias smallint not null default 180;

do $$
begin
  alter table public.organizations drop constraint if exists organizations_classificacao_dias_check;
  alter table public.organizations add constraint organizations_classificacao_dias_check
    check (classificacao_ativo_dias between 1 and 3650
       and classificacao_pre_inativo_dias between 1 and 3650
       and classificacao_pre_inativo_dias > classificacao_ativo_dias);
end $$;

-- Recalcula o last_won_at de UM contato a partir de crm_leads.
create or replace function public.fn_recalcular_ultima_venda(p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ultima timestamptz;
begin
  if p_contact_id is null then
    return;
  end if;

  select max(l.closed_at) into v_ultima
    from public.crm_leads l
   where l.contact_id = p_contact_id
     and l.status = 'won';

  perform set_config('deskcomm.ultima_venda_pelo_lead', 'on', true);
  update public.contacts
     set last_won_at = v_ultima
   where id = p_contact_id
     and last_won_at is distinct from v_ultima;
  perform set_config('deskcomm.ultima_venda_pelo_lead', '', true);
end $$;

revoke execute on function public.fn_recalcular_ultima_venda(uuid) from public, anon, authenticated;
grant execute on function public.fn_recalcular_ultima_venda(uuid) to service_role;

create or replace function public.fn_crm_lead_ultima_venda()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.contact_id is not null
     and (tg_op = 'DELETE'
       or old.contact_id is distinct from new.contact_id
       or old.status = 'won') then
    perform public.fn_recalcular_ultima_venda(old.contact_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.contact_id is not null and new.status = 'won'
     and (tg_op = 'INSERT'
       or old.contact_id is distinct from new.contact_id
       or old.status is distinct from new.status
       or old.closed_at is distinct from new.closed_at) then
    perform public.fn_recalcular_ultima_venda(new.contact_id);
  end if;

  return null;
end $$;

-- Função de trigger não exige EXECUTE de quem dispara a escrita.
revoke execute on function public.fn_crm_lead_ultima_venda() from public, anon, authenticated;

drop trigger if exists trg_crm_lead_ultima_venda on public.crm_leads;
create trigger trg_crm_lead_ultima_venda
  after insert or update of status, closed_at, contact_id or delete on public.crm_leads
  for each row
  execute function public.fn_crm_lead_ultima_venda();

-- Guarda: sessão nenhuma grava as duas colunas de venda. O gatilho acima passa
-- pela flag de transação; service role e migrations não têm auth.uid().
create or replace function public.fn_colunas_de_venda_sao_do_sistema()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null
     and coalesce(current_setting('deskcomm.ultima_venda_pelo_lead', true), '') <> 'on' then
    raise exception 'colunas_de_venda_sao_do_sistema' using errcode = '42501';
  end if;
  return new;
end $$;

revoke execute on function public.fn_colunas_de_venda_sao_do_sistema() from public, anon, authenticated;

drop trigger if exists trg_contato_colunas_de_venda on public.contacts;
create trigger trg_contato_colunas_de_venda
  before update on public.contacts
  for each row
  when (old.last_won_at is distinct from new.last_won_at
     or old.pre_inativo_avisado_para is distinct from new.pre_inativo_avisado_para)
  execute function public.fn_colunas_de_venda_sao_do_sistema();

-- Backfill: o last_won_at de todo contato com negócio ganho.
with ultima as (
  select l.contact_id, max(l.closed_at) as em
    from public.crm_leads l
   where l.status = 'won' and l.contact_id is not null
   group by l.contact_id
)
update public.contacts c
   set last_won_at = u.em
  from ultima u
 where c.id = u.contact_id
   and c.last_won_at is distinct from u.em;

-- O kind novo do aviso. A constraint é reconstruída com a lista INTEIRA do
-- baseline (kind-check-migration-x-baseline): o valor novo entra antes de 'other'.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice',
    'proposal_acceptance_rate_drop',
    'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    'task_due',
    'task_overdue',
    'recuperacao_da_queda',
    'cliente_sem_resposta_na_queda',
    'assinatura_desconectada',
    'client_pre_inactive',
    'other'
  ));
