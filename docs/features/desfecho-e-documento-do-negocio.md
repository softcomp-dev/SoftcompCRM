# Desfecho e documento do negócio: ganho parcial, cor do card e número da cotação ou do pedido

Três mudanças no negócio do funil (`crm_leads`), todas para quem vende por cotação e
fecha por pedido.

## 1. Ganho parcial

**Onde:** menu "⋯" do card no funil › **Marcar como ganho parcial**. O diálogo
(`components/kanban/PartialWinDialog.tsx`) pede o **Valor fechado**, mostra o
**Previsto** ao lado, e pede o **Motivo** ("Ex.: o cliente levou só parte do pedido").

- **É uma marca sobre o ganho, não um quarto status** (migration 9259). O negócio fica
  `status = 'won'` e conta como venda em todo lugar: conversão, metas, e a data da
  última venda do contato, que alimenta a
  [classificação de clientes](classificacao-de-clientes.md). Um quarto valor de
  `status` obrigaria os cerca de 90 lugares que perguntam por `'won'` a lembrar dele.
- **O valor:** `value_cents` passa a ser o valor efetivamente fechado, que é o que a
  receita soma. O previsto fica em `partial_original_value_cents`. Remarcar um parcial
  nunca transforma o valor fechado em "previsto".
- **Recusas** (as mesmas na rota e no diálogo, em `lib/leads/ganho-parcial.ts`): sem
  valor ("Informe o valor efetivamente fechado.") e valor que não é menor que o previsto
  ("No ganho parcial o valor fechado precisa ser menor que o previsto."). O motivo vai
  de 1 a 500 caracteres.
- **Negócio que já estava ganho** também pode virar parcial. Isso grava a auditoria
  `lead.partial_win`. Ganhar direto como parcial grava `lead.won` com `partial` no
  metadata.
- **Reabrir** limpa a marca e devolve o valor previsto (gatilho
  `trg_crm_lead_parcial_some_ao_reabrir`). O banco recusa parcial fora de ganho ou sem
  motivo (CHECK `crm_leads_parcial_coerente`).

**API:** `POST /api/v1/leads/{id}/win` aceita `partial: { value_cents, reason }`. Sem
esse campo o ganho é total.

## 2. Cor do desfecho no card

Os cards fechados ganham uma faixa à esquerda e um fundo levemente tingido:
**verde** para ganho, **vermelho** para perdido e **âmbar** para ganho parcial. Os
cards abertos continuam como estavam. O desfecho também entra no nome acessível do card
("Negócio: <título> (<desfecho>)").

| Peça | Artefato |
|---|---|
| Regra e cores | `lib/kanban/desfecho-do-card.ts` (`desfechoDoCard`, `CORES_DO_DESFECHO`, `rotuloDoDesfecho`) |
| Card | `components/kanban/KanbanCard.tsx` (atributo `data-desfecho`) |
| Teste | `components/kanban/KanbanCard.desfecho.test.tsx` |

## 3. Número da cotação ou do pedido

**Onde:** na edição do negócio, tanto no funil (`EditLeadDialog`) quanto no dossiê da
conversa (`LeadFieldsForm`). O campo é **Número da cotação ou do pedido**, com a escolha
**Cotação** ou **Pedido** ao lado (`components/kanban/CampoDocumentoDeVenda.tsx`).

- **Um tipo e um número, nunca dois números.** O negócio é cotação *ou* pedido: quando a
  cotação vira pedido, troca-se a escolha e o número. O banco recusa o par incompleto
  (`crm_leads_documento_de_venda_coerente`, migration 9260), e
  `lib/leads/documento-de-venda.ts` aplica a mesma régua antes de gravar.
- **Apagar o número limpa o documento inteiro.**
- O número vai de 1 a 60 caracteres e é gravado como o sistema de gestão o escreve.
- A mudança entra na linha do tempo do negócio e na auditoria (`lead.updated`), com o
  antes e o depois.

**API:** `PATCH /api/v1/leads/{id}` aceita `sales_document_kind` (`quote` ou `order`) e
`sales_document_number`.

Não confunda com o `external_id` da [integração com ERP](../api/integracao-erp.md). O
`external_id` é a chave com que o ERP cria e acha o negócio
(`GET /api/v1/leads/by-external/{source}/{external_id}`), e não aparece na tela. O
documento de venda é o número que a equipe lê e edita na ficha do negócio.

## Laço de retorno

- Parcial marcado por engano: reabrir o negócio devolve o valor previsto, e marcar de
  novo como ganho total resolve.
- Número errado: corrige-se na mesma edição, e a linha do tempo mostra o antes e o
  depois.
