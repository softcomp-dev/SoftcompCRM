-- manifest: **Cada item da proposta tem o seu status.** `crm_proposal_items` ganha `status` (`pendente` | `aceito` | `recusado` na cotação; `em_producao` | `entregue` depois que a cotação aceita vira pedido) e `status_changed_at`. O cliente pode aceitar parte dos itens: a proposta se resolve quando nenhum item fica pendente, e o valor do negócio passa a ser a soma dos itens aceitos. Itens de propostas já decididas recebem o status coerente com a decisão (aceita → aceito, recusada → recusado). Idempotente.
-- ---- status do item da proposta (migration 9261) ----
--
-- ─── A dor ────────────────────────────────────────────────────────────────
--
-- Quem vende vários produtos no mesmo negócio (aço por bitola, por exemplo)
-- recebe resposta POR ITEM: "fecho o 1020, o 1045 fica para depois". A
-- proposta só sabia ser aceita ou recusada inteira, e o valor do negócio
-- ficava com o total cheio de um pedido que não foi feito.
--
-- ─── A decisão ────────────────────────────────────────────────────────────
--
-- O status mora NO ITEM DA PROPOSTA, e não numa tabela de "itens do negócio"
-- ao lado: os produtos negociados já são os itens da proposta, e uma segunda
-- lista seria a segunda fonte da mesma verdade (DIRC).
--
--   cotação (proposta `enviada`):        pendente → aceito | recusado
--   pedido  (proposta `aceita` e negócio com `sales_document_kind = 'order'`):
--                                        aceito → em_producao → entregue
--
-- A fase é regra do servidor (`lib/propostas/status-do-item.ts`), não do
-- CHECK: o CHECK só garante o vocabulário. O conteúdo do item (descrição,
-- quantidade, preço) continua congelado depois do envio — a policy de escrita
-- segue exigindo rascunho, e a rota de status escreve só as duas colunas
-- novas, pelo cliente de serviço, filtrando a organização.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `add column if not exists` com default: linhas existentes nascem
-- `pendente`. O backfill alinha os itens das propostas JÁ decididas com a
-- decisão e só toca linha `pendente`, então reaplicar não muda nada.

alter table public.crm_proposal_items
  add column if not exists status text not null default 'pendente',
  add column if not exists status_changed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_proposal_items'::regclass
       and conname  = 'crm_proposal_items_status_conhecido'
  ) then
    alter table public.crm_proposal_items
      add constraint crm_proposal_items_status_conhecido
      check (status in ('pendente', 'aceito', 'recusado', 'em_producao', 'entregue'));
  end if;
end
$$;

-- Backfill genérico: proposta aceita inteira → itens aceitos; recusada →
-- itens recusados. A data é a da decisão da proposta.
update public.crm_proposal_items i
   set status = case p.status when 'aceita' then 'aceito' else 'recusado' end,
       status_changed_at = coalesce(p.decided_at, p.updated_at)
  from public.crm_proposals p
 where p.id = i.proposal_id
   and p.organization_id = i.organization_id
   and p.status in ('aceita', 'recusada')
   and i.status = 'pendente';

comment on column public.crm_proposal_items.status is
  'Status do item (migration 9261). Cotação: pendente | aceito | recusado. Pedido (proposta aceita e negócio com sales_document_kind = order): em_producao | entregue, a partir de aceito. A fase é regra de lib/propostas/status-do-item.ts.';
comment on column public.crm_proposal_items.status_changed_at is
  'Quando o status do item mudou pela última vez (migration 9261). Nulo = pendente desde a criação.';

-- Coluna nova herda o GRANT da tabela; restate explícito como na 9260.
grant select, insert, update, delete on public.crm_proposal_items to authenticated;
grant all on public.crm_proposal_items to service_role;

-- Travas de suporte (migration 0274), DEPOIS das colunas.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
