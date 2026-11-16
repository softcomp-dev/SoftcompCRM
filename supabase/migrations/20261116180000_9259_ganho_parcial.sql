-- manifest: **Ganho parcial.** `crm_leads` ganha `is_partial_win` (default false), `partial_reason` e `partial_original_value_cents`. O parcial é um GANHO (`status = 'won'`), então conversão, metas e `contacts.last_won_at` o contam sem mudança; `value_cents` passa a ser o valor efetivamente fechado e o previsto fica em `partial_original_value_cents`. CHECK `crm_leads_parcial_coerente` (parcial só em ganho e com motivo). Gatilho `trg_crm_lead_parcial_some_ao_reabrir` limpa a marca e devolve o valor previsto quando o negócio sai do ganho. Idempotente; apêndice espelhado no `baseline.sql`.

-- 9259 — ganho parcial.
--
-- ─── Por que NÃO é um quarto status ────────────────────────────────────────
--
-- `status` é `open | won | lost` e ~90 lugares (métricas do funil, metas,
-- `last_won_at` do contato, conversões, filtros) perguntam por `'won'`. O
-- parcial CONTA COMO VENDA (decisão do dono do produto, 16/11/2026): um quarto
-- valor obrigaria cada um desses lugares a lembrar dele, e o que esquecesse
-- deixaria de contar uma venda em silêncio. Como marca sobre o ganho, todos
-- continuam certos sem mudar uma linha.
--
-- ─── O valor ───────────────────────────────────────────────────────────────
--
-- `value_cents` é o que foi efetivamente fechado — é o que a receita soma. O
-- valor que se previa fica em `partial_original_value_cents`, para a tela
-- mostrar "R$ 600 de R$ 1.000" e para a reabertura devolvê-lo.
--
-- ─── A reabertura ──────────────────────────────────────────────────────────
--
-- O status é de `fn_crm_lead_close_on_stage` (BEFORE, pela etapa). O gatilho
-- novo roda DEPOIS dele no mesmo BEFORE UPDATE (ordem alfabética: `close` <
-- `parcial`) e, se o negócio deixou de ser ganho, apaga a marca e devolve o
-- valor previsto. Sem isso a CHECK recusaria reabrir um parcial. Não faz HTTP.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `add column if not exists`; CHECK dentro de bloco DO; `create or replace
-- function`; `drop trigger if exists` + `create trigger`. Linhas existentes
-- nascem `is_partial_win = false` e passam na CHECK — não há backfill.

alter table public.crm_leads
  add column if not exists is_partial_win boolean not null default false,
  add column if not exists partial_reason text,
  add column if not exists partial_original_value_cents bigint;

comment on column public.crm_leads.is_partial_win is
  'Ganho parcial (migration 9259): o negócio foi ganho (status = won) com menos do que se previa. Conta como venda em toda métrica. value_cents é o valor fechado; o previsto fica em partial_original_value_cents.';
comment on column public.crm_leads.partial_reason is
  'Motivo do ganho parcial (migration 9259). Obrigatório quando is_partial_win (CHECK crm_leads_parcial_coerente).';
comment on column public.crm_leads.partial_original_value_cents is
  'Valor previsto antes do fechamento parcial (migration 9259). Devolvido a value_cents quando o negócio sai do ganho (trg_crm_lead_parcial_some_ao_reabrir).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'crm_leads_parcial_coerente'
       and conrelid = 'public.crm_leads'::regclass
  ) then
    alter table public.crm_leads
      add constraint crm_leads_parcial_coerente check (
        not is_partial_win
        or (status = 'won' and partial_reason is not null and length(btrim(partial_reason)) > 0)
      );
  end if;
end $$;

create or replace function public.fn_crm_lead_parcial_some_ao_reabrir()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if new.is_partial_win and new.status is distinct from 'won' then
    new.value_cents := coalesce(new.partial_original_value_cents, new.value_cents);
    new.is_partial_win := false;
    new.partial_reason := null;
    new.partial_original_value_cents := null;
  end if;
  return new;
end$function$;

revoke execute on function public.fn_crm_lead_parcial_some_ao_reabrir() from public, anon, authenticated;

drop trigger if exists trg_crm_lead_parcial_some_ao_reabrir on public.crm_leads;
create trigger trg_crm_lead_parcial_some_ao_reabrir
  before update on public.crm_leads
  for each row execute function public.fn_crm_lead_parcial_some_ao_reabrir();
