-- manifest: Histórico de atendimento: a interação que o vendedor registra à mão e em que falou com o cliente (`interaction_logged`) passa a carimbar `last_activity_at` do negócio e do contato; a tentativa sem resposta (`interaction_attempted`) não carimba, pela mesma régua de `voice_call`/`voice_call_missed`.
--
-- Por quê: a ligação feita do celular, a reunião e a visita não passam pelo
-- CRM. Sem esta linha na lista positiva, o vendedor registrava que passou meia
-- hora com o cliente e o Radar de Risco seguia marcando o negócio como frio.
--
-- Só a lista muda; o corpo é o da 0235. Idempotente (`create or replace`). A
-- função é de gatilho e já tem os grants do dump; nada novo é exposto.

create or replace function public.fn_update_last_activity_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  -- LISTA POSITIVA: só isto conta como "alguém tocou este negócio". Tipo que
  -- não está aqui NÃO quebra o silêncio — inclusive tipo que ainda não existe.
  -- Ver o cabeçalho da 0079 antes de acrescentar linha nesta lista.
  if new.type not in (
    'ai_turn',              -- a IA falou com o cliente
    'note',                 -- alguém registrou trabalho no negócio
    'lead_edited',          -- humano mexeu nos dados
    'stage_changed',        -- humano moveu o negócio
    'next_action_approved', -- humano decidiu agir
    -- (0235) Uma ligação ATENDIDA é interação, e das mais fortes: alguém falou
    -- com o cliente. `voice_call_missed` NÃO entra: telefone que tocou sem
    -- resposta é constatação de silêncio, não quebra dele.
    'voice_call',
    -- (9254) A interação que o vendedor REGISTROU à mão e em que falou com o
    -- cliente (ligação do celular, reunião, visita, e-mail). Pela mesma régua,
    -- `interaction_attempted` ("liguei e não atendeu") NÃO entra.
    'interaction_logged'
  ) then
    return new;
  end if;

  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;
  return new;
end$function$;
