# Status por item da proposta: aceite parcial na cotação, produção e entrega no pedido

Um negócio do funil pode ter vários produtos sendo negociados com o mesmo cliente. Os
produtos são os **itens da proposta** do negócio (`crm_proposal_items`), e cada item tem
agora o seu status (migration 9261). Não há uma segunda lista de "itens do negócio": a
proposta é a fonte.

## Onde aparece

- **No card do negócio** (dossiê do funil, seção **Propostas**): abaixo da lista, a
  tabela da proposta vigente — a mais recente que não foi cancelada nem substituída —
  com **Descrição**, **Valor unitário**, **Quantidade**, **Total** e **Status**
  (`components/kanban/PropostasDoNegocio.tsx`).
- **Na tela da proposta** (`/app/proposals/{id}`): coluna **Status** na tabela de itens,
  fora do rascunho (`app/app/proposals/[id]/_client.tsx`).

Nos dois lugares o status é um selo colorido e vira seletor quando a fase permite mudar
(`components/propostas/StatusDoItem.tsx`). Mudar é `agent`+.

## As duas fases

A regra mora em `lib/propostas/status-do-item.ts`, e o servidor confere de novo.

| Fase | Quando | Status do item |
|---|---|---|
| **Cotação** | proposta **enviada** | Pendente, Aceito, Recusado (dá para voltar atrás) |
| **Pedido** | proposta **aceita** e negócio marcado como **Pedido** no campo "Número da cotação ou do pedido" (`crm_leads.sales_document_kind = 'order'`) | Aceito → Em produção → Entregue (dá para corrigir) |

- **A proposta se resolve pelos itens.** Quando nenhum item fica pendente, ela vira
  **aceita** se pelo menos um foi aceito (aceite parcial é aceite) ou **recusada** se
  todos foram recusados. O rastro é o mesmo da decisão inteira: atividade no negócio,
  retorno automático cancelado e auditoria (`lib/propostas/efeitos-da-decisao.ts`).
- **"Marcar como aceita/recusada" continua valendo.** A decisão inteira aplica o
  status aos itens que ainda estavam pendentes; o item que alguém já tinha decidido um
  a um fica como está.
- **O valor do negócio vira a soma do que foi vendido** (aceito, em produção e
  entregue), com a mesma conta do total da proposta. O total original continua na
  proposta. A recusa não mexe no valor (spec §16.2).
- **O item recusado não entra no pedido**, e nada volta a pendente depois da cotação.
- **Produção e entrega só existem no pedido.** Com a proposta aceita num negócio que
  ainda está como Cotação, a tela mostra a dica de marcar o negócio como Pedido.
- **O conteúdo do item continua congelado depois do envio.** A rota de status grava só
  `status` e `status_changed_at`; descrição, quantidade e preço não mudam.

## API

`PATCH /api/v1/proposals/{id}/itens` com `{ "itens": [{ "id": "<uuid>", "status": "aceito" }] }`
(1 a 200 itens). Devolve `{ id, status, fase, itens }`, em que `status` é o da proposta
depois da mudança. Recusas: 404 (proposta de outra organização), 409 (proposta fora de
fase, ou item mudado por outra pessoa no meio), 422 (item que não é da proposta, com os
ids em `details.itens`, ou status que a fase não aceita). Hoje só por sessão (cookie).

O `GET /api/v1/proposals/{id}` devolve `fase_dos_itens` (`cotacao`, `pedido` ou `null`).

## Rastro

| O quê | Onde |
|---|---|
| Atividade no negócio | `proposal_item_status_changed`, com os itens e o status novo no motivo |
| Valor recalculado | `proposal_value_changed` |
| Auditoria | `proposal.item_status_changed` (ids e status novo no metadata) |

## Laço de retorno

- Item marcado errado na cotação: volta-se o seletor (inclusive para Pendente) enquanto a
  proposta não se resolve.
- Proposta resolvida por engano pelo último item: o caminho é o de sempre, revisar a
  proposta (v2), que nasce com todos os itens pendentes.
- Produção ou entrega marcada errada: o seletor do pedido corrige para qualquer um dos
  três status.
