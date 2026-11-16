-- manifest: **O negócio guarda o número da COTAÇÃO ou do PEDIDO.** `crm_leads` ganha `sales_document_kind` (`quote` = cotação, `order` = pedido) e `sales_document_number` (texto livre de 1..60 caracteres, porque o número vem do ERP de cada cliente e pode ter letras, barras e zeros à esquerda). Um negócio tem UM ou OUTRO, nunca os dois: é uma coluna de tipo, não duas colunas de número. O CHECK `crm_leads_documento_de_venda_coerente` exige o par inteiro (os dois nulos ou os dois preenchidos). As colunas nascem nulas, então nenhum negócio existente muda. Idempotente.
-- ---- número da cotação ou do pedido do negócio (migration 9260) ----
--
-- ─── A dor ────────────────────────────────────────────────────────────────
--
-- Quem vende por cotação e fecha por pedido no ERP não tinha onde anotar no
-- negócio qual é o documento correspondente lá fora. O número ia para a
-- descrição, onde nenhuma busca, relatório ou integração consegue lê-lo.
--
-- ─── A decisão ────────────────────────────────────────────────────────────
--
--   sales_document_kind   text — `quote` (cotação) ou `order` (pedido);
--   sales_document_number text — o número como o ERP o escreve, 1..60.
--
-- UM tipo e UM número, e não `quote_number` + `order_number`: o negócio é uma
-- coisa OU a outra. Duas colunas deixariam gravar as duas ao mesmo tempo, e
-- quem lesse não saberia qual vale. Quando a cotação vira pedido, troca-se o
-- tipo e o número na mesma escrita.
--
-- `text` e não número: "PV-000123/2026" é um número de pedido real, e zero à
-- esquerda não sobrevive a `integer`.
--
-- O par é coerente pelo BANCO (`crm_leads_documento_de_venda_coerente`): tipo
-- sem número não diz nada, e número sem tipo não diz o que é. A tela e a API já
-- mandam o par inteiro; o CHECK existe para quem escreve por fora.

alter table public.crm_leads
  add column if not exists sales_document_kind   text,
  add column if not exists sales_document_number text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_leads'::regclass
       and conname  = 'crm_leads_sales_document_kind_conhecido'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_sales_document_kind_conhecido
      check (sales_document_kind is null or sales_document_kind in ('quote', 'order'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_leads'::regclass
       and conname  = 'crm_leads_sales_document_number_tamanho'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_sales_document_number_tamanho
      check (
        sales_document_number is null
        or (length(btrim(sales_document_number)) between 1 and 60
            and sales_document_number = btrim(sales_document_number))
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_leads'::regclass
       and conname  = 'crm_leads_documento_de_venda_coerente'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_documento_de_venda_coerente
      check ((sales_document_kind is null) = (sales_document_number is null));
  end if;
end
$$;

do $$
begin
  if to_regclass('public.crm_leads') is not null then
    comment on column public.crm_leads.sales_document_kind is
      'O que é o documento de venda do negócio: quote (cotação) ou order (pedido). Um ou outro, nunca os dois. Preenchido junto com sales_document_number (CHECK crm_leads_documento_de_venda_coerente). Migration 9260.';
    comment on column public.crm_leads.sales_document_number is
      'Número da cotação ou do pedido como o ERP o escreve (1..60 caracteres, sem espaço nas pontas). Nulo = negócio sem documento. Migration 9260.';
  end if;
end
$$;

-- Coluna nova herda o GRANT da tabela; restate explícito como na 9028.
grant select, insert, update, delete on public.crm_leads to authenticated;
grant all on public.crm_leads to service_role;

-- Travas de suporte (migration 0274), DEPOIS das colunas.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
