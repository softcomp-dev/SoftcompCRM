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

## Uma regra, três portas

A regra inteira (fase, trava contra edição simultânea, atividade, auditoria, desfecho da
proposta e valor do negócio) mora em `lib/propostas/mudar-status-dos-itens.ts`. A tela, a
API por token e as ferramentas de IA chamam a mesma função; nenhuma repete a regra.

### API REST (sessão ou token)

`PATCH /api/v1/proposals/{id}/itens` com `{ "itens": [{ "id": "<uuid>", "status": "aceito" }] }`
(1 a 200 itens). Devolve `{ id, status, fase, itens }`, em que `status` é o da proposta
depois da mudança. Recusas: 404 (proposta de outra organização), 409 (proposta fora de
fase, ou item mudado por outra chamada no meio), 422 (item que não é da proposta, com os
ids em `details.itens`, ou status que a fase não aceita).

- **Pela tela:** sessão (cookie), papel `agent`+.
- **Por integração (ERP):** `Authorization: Bearer dsk_…` com `mcp:write` e papel `agent`,
  organização tirada da linha do token, teto de escrita do token (429). Quando o último
  item resolve a proposta, `decided_by_user_id` fica nulo (quem decidiu foi a integração)
  e a auditoria guarda o token. O proxy libera o caminho em `lib/auth/public-paths.ts`;
  contrato na OpenAPI (`mudarStatusDosItensDaProposta`) e em
  [`docs/api/integracao-erp.md`](../api/integracao-erp.md).

O `GET /api/v1/proposals/{id}`, por sessão e por token, devolve `status` e
`status_changed_at` de cada item e `fase_dos_itens` (`cotacao`, `pedido` ou `null`).

### Agente de IA e cliente MCP

| Ferramenta | O que faz | No catálogo |
|---|---|---|
| `crm_get_proposal_items` | Lê os itens da proposta (ou da vigente do negócio) com status, total e fase | pacote **Não perder o cliente**, risco seguro |
| `crm_update_proposal_items_status` | Registra aceito/recusado (cotação) ou em produção/entregue (pedido) | pacote **Vender**, risco **crítico**: só entra no agente marcada à mão |

- As duas só aparecem com a capacidade **Propostas** ligada.
- A escrita exige `lead_id` e confere que a proposta é daquele negócio, para valer o
  escopo de funil do agente (`lib/leads/escopo-de-funil.ts`).
- Numa conversa, proposta de outro contato é recusada antes de qualquer dado sair ou
  ser gravado (`lib/ai/runtime/escopo-das-escritas.ts`, dono `proposta`).
- A descrição manda registrar só com a confirmação explícita do cliente sobre cada
  item. O Operador não recebe a escrita (`FORA_DO_OPERADOR`): ele não tem a frase do
  cliente.
- Recusa da regra não conta como efeito (`motivoDoVazio`), então o agente não afirma ao
  cliente que registrou algo que não foi gravado.

## PDF

No envio todo item é pendente e o PDF que o cliente recebe não muda. Depois que algum
item foi respondido, o PDF ("Ver como o cliente recebe") mostra o status em cada linha,
apaga o item recusado e separa **Total aceito** de **Total proposto** quando diferem
(`lib/propostas/documento/pdf-do-documento.tsx`).

## Rastro

| O quê | Onde |
|---|---|
| Atividade no negócio | `proposal_item_status_changed`, com os itens e o status novo no motivo |
| Valor recalculado | `proposal_value_changed` |
| Auditoria | `proposal.item_status_changed` (ids, status novo e a porta — `tela`, `token` ou `mcp` — no metadata; o token em `actor_api_token_id`) |

## Laço de retorno

- Item marcado errado na cotação: volta-se o seletor (inclusive para Pendente) enquanto a
  proposta não se resolve.
- Proposta resolvida por engano pelo último item: o caminho é o de sempre, revisar a
  proposta (v2), que nasce com todos os itens pendentes.
- Produção ou entrega marcada errada: o seletor do pedido corrige para qualquer um dos
  três status.
