-- manifest: Telefonia SIP: o número de voz ganha "encaminhar para" (`phone_numbers.forward_to_phone` e `forward_ring_seconds`), o telefone do time que atende nos modos "Time humano" e "IA, depois time humano"; `fn_resolve_inbound_number` passa a devolvê-los junto com o `trunk_endpoint`.
--
-- Por quê: `routing_mode` existia desde a 0347, a tela deixava escolher
-- "Time humano", e o worker de voz ignorava a escolha — toda ligação ia para a
-- IA, e sem agente de voz ela caía. O atendimento humano, nesta fase, é o
-- encaminhamento da ligação para um telefone do time (celular ou fixo) pelo
-- mesmo tronco SIP. O telefone no navegador (WebRTC) é a fase seguinte e não
-- está aqui — ver docs/specs/36-spec-telefonia-sip-atendimento-humano.md.
--
-- Idempotente: colunas `if not exists`, constraints com `drop ... if exists`
-- antes, função recriada. As colunas nascem vazias/no default, então nenhuma
-- linha existente viola as constraints novas.
--
-- A função muda o tipo de retorno (`returns table` ganha colunas), o que
-- `create or replace` não aceita: por isso o `drop` antes. Ela continua
-- `security definer` com `search_path` vazio e só para `service_role` — o
-- único chamador é o worker de voz.

alter table public.phone_numbers
  add column if not exists forward_to_phone text;
alter table public.phone_numbers
  add column if not exists forward_ring_seconds integer not null default 25;

alter table public.phone_numbers
  drop constraint if exists phone_numbers_forward_to_phone_check;
alter table public.phone_numbers
  add constraint phone_numbers_forward_to_phone_check
  check (forward_to_phone is null or forward_to_phone ~ '^\+?[0-9]{8,15}$');

alter table public.phone_numbers
  drop constraint if exists phone_numbers_forward_ring_seconds_check;
alter table public.phone_numbers
  add constraint phone_numbers_forward_ring_seconds_check
  check (forward_ring_seconds between 10 and 60);

comment on column public.phone_numbers.forward_to_phone is
  'Telefone do time (só dígitos, + opcional) para onde a ligação é encaminhada nos modos human e ai_then_human. Discado pelo mesmo tronco SIP.';
comment on column public.phone_numbers.forward_ring_seconds is
  'Quanto tempo o telefone do time toca antes de a ligação virar perdida (10 a 60 s).';

drop function if exists public.fn_resolve_inbound_number(text);

create function public.fn_resolve_inbound_number(p_number text)
returns table (
  organization_id uuid,
  routing_mode text,
  default_ai_agent_id uuid,
  fallback_user_id uuid,
  forward_to_phone text,
  forward_ring_seconds integer,
  trunk_endpoint text
)
language sql
security definer
stable
set search_path = ''
as $$
  select organization_id, routing_mode, default_ai_agent_id, fallback_user_id,
         forward_to_phone, forward_ring_seconds, trunk_endpoint
  from public.phone_numbers
  where number = p_number and is_active
  limit 1;
$$;

revoke execute on function public.fn_resolve_inbound_number(text) from public, anon, authenticated;
grant execute on function public.fn_resolve_inbound_number(text) to service_role;

notify pgrst, 'reload schema';
