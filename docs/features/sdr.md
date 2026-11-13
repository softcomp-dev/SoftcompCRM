# Função SDR

SDR (Sales Development Representative) é quem faz a pré-venda: aborda, qualifica
e passa o lead pronto ao closer. Aqui a função é **por organização** (cada
empresa liga ou não) e **por membro** (cada um é marcado ou não).

## SDR não é papel

Os papéis (`viewer` < `agent` < `manager` < `admin`) são uma escada de **poder**,
lida pela RLS e por `requireRole`. SDR é uma **função comercial** que se soma ao
papel, e por isso não entrou na escada: nenhuma policy mudou, e um `manager` SDR
continua com tudo o que um `manager` tem.

## Pela tela

Em **Equipe › Membros** (`/app/team`):

1. O cartão **Função SDR**, acima da tabela, tem o interruptor da empresa. Só o
   administrador muda; o gerente vê se está ligada.
2. Com a função ligada, a tabela ganha a coluna **SDR**. O administrador marca e
   desmarca cada pessoa pela chave da linha. A chave fica travada para quem tem
   o papel **Somente leitura** e para quem teve o acesso revogado.
3. Uma marca que perdeu o efeito continua na tabela com o motivo ("Sem efeito: o
   papel Somente leitura não pode ser SDR." ou "Sem efeito: acesso revogado."), e
   pode ser desmarcada.

Desligada a função, a coluna some e as marcas ficam guardadas: religar devolve a
equipe como estava. Componentes: `app/app/team/_components/SdrCard.tsx` e
`SdrCell.tsx`; hooks em `hooks/sdr/useSdr.ts`.

## Onde mora cada coisa

| O quê | Onde | Fonte |
|---|---|---|
| Interruptor da empresa | `organizations.settings.sdr.enabled` (padrão `false`) | `lib/sdr/configuracao.ts` |
| Quem é SDR | `user_organizations.sdr_since` (null = não é) | migration 9252 |
| O que o SDR pode | calculado, nunca gravado | `lib/sdr/permissoes.ts` |
| Marcar e desmarcar | `UPDATE` condicional | `lib/sdr/atribuicao.ts` |
| Quem marcou e quando | `api_audit_log` (`sdr.*`) | — |

## A regra, e por que ela garante consistência

A marca só vale quando as quatro condições valem **juntas**:

1. a empresa ligou a função;
2. o vínculo está ativo (`revoked_at` nulo);
3. o papel é `agent` ou acima;
4. o membro está marcado.

Nenhuma mudança nessas condições apaga a marca. Desligar a função, rebaixar para
`viewer` ou revogar o membro tiram as permissões **na próxima leitura**, sem
cron, sem trigger e sem limpeza; desfazer a mudança as devolve. Não há estado
derivado para ficar desatualizado, porque não há estado derivado gravado.

Marcar é um `UPDATE` só, condicionado a organização, vínculo ativo, papel
elegível e marca ainda vazia. Não existe janela entre "conferir" e "gravar": uma
revogação concorrente ou acontece antes (e nada é gravado) ou depois (e a marca
fica sem efeito pela regra acima). Apagar o vínculo apaga a marca junto, porque
ela é uma coluna dele.

## Permissões

`GET /api/v1/sdr/permissions` devolve, na ordem abaixo, só as que valem:

| Permissão | Quem tem |
|---|---|
| `sdr.settings.manage` | admin ativo, **mesmo com a função desligada** (senão ninguém a liga) |
| `sdr.assignments.view` | manager+ ativo, função ligada |
| `sdr.assignments.manage` | admin ativo, função ligada |
| `sdr.leads.prospect` | SDR ativo |
| `sdr.leads.qualify` | SDR ativo |
| `sdr.leads.handoff` | SDR ativo |

⚠️ **As três `sdr.leads.*` são nomes de contrato para integrador.** A
distribuição de leads novos (abaixo) usa a MESMA regra de "SDR ativo", mas pela
função (`motivoSdrInativo`), não lendo essas strings. Quem acessa cada lead
continua decidido pelo papel e pela visibilidade de sempre. Para conferir quem
lê as strings sem confiar nesta linha:

```bash
git grep -n "sdr.leads" -- app lib components ':!lib/sdr' ':!*.test.ts'
```

## Distribuição de leads novos: os dois fluxos

Cada empresa escolhe o fluxo, e ele é decidido por
`lib/sdr/distribuicao.ts`, consultada pelo worker de roteamento
(`lib/routing/worker.ts`) sempre que ele vai montar a lista do rodízio:

| Situação da empresa | Quem recebe o lead novo |
|---|---|
| Função SDR desligada (o padrão) | a equipe inteira, como sempre |
| Ligada, mas nenhum SDR ativo | a equipe inteira (configuração incompleta não para a entrada) |
| Ligada e ao menos um SDR ativo | **só os SDRs ativos** |

No fluxo SDR, se todos os SDRs estiverem ocupados (sem folga), indisponíveis ou
fora do horário, o lead **espera um SDR** na fila: o worker reenfileira, e depois
das tentativas abre o aviso de sempre (`fn_routing_unassigned_notice`). Ele não
vaza para o resto da equipe.

O que continua valendo por cima do fluxo SDR:

- **Modo da distribuição.** Em modo `manual` ninguém recebe lead sozinho, SDR ou
  não; o fluxo só vale em `round_robin` e `load`. O cartão da tela avisa.
- **Responsáveis do número e fila (setor).** O recorte SDR é **interseção**:
  recebe quem é SDR **e** responde por aquele número **e** está na fila. Se
  nenhum SDR responde pelo número, o lead daquele número espera — ajuste os
  responsáveis do número em Configurações › Atendimento.
- **Destino padrão do número** continua sendo entrega direta à pessoa escolhida
  (é a regra mais específica), mesmo que ela não seja SDR.
- **Carteira do cliente.** Conversa que já chega com dono não passa pelo rodízio.

O que **não** muda: a passagem da IA para um humano no meio do atendimento
(`lib/mcp/tools/handoff.ts`) e o resumo da fila seguem com a equipe inteira —
pedir uma pessoa no meio de uma conversa não é lead novo.

Cada evento de roteamento grava `distribuicao: "sdr" | "equipe"` no metadata do
`event_log` (no fechamento e no reenfileiramento), para investigar por que um
lead foi para alguém ou ficou esperando. O GET do interruptor devolve o fluxo em
vigor, e o cartão da tela de Equipe o mostra.

Janela conhecida: a marca é lida antes do claim (`fn_channel_routing_claim`),
que não conhece SDR. Desmarcar alguém no mesmo segundo em que um lead é
entregue a ele pode deixar esse lead com quem acabou de deixar de ser SDR.

## Passar o negócio para o vendedor

O SDR qualifica e escolhe quem fecha. No menu "⋯" do card do funil, o SDR ativo
vê **Passar para vendedor**, com a lista dos vendedores que podem receber.

| Regra | Onde |
|---|---|
| Quem passa: SDR ativo | `recusaDoSdr` em `lib/sdr/passagem.ts` |
| O que passa: negócio aberto que está com o SDR ou sem dono humano (fila ou agente de IA) | `recusaDoNegocio` |
| Para quem: membro ativo que aceitou o convite, papel agent ou acima, que não é SDR ativo nem o próprio SDR | `recusaDoVendedor` / `vendedoresParaOSdr` |

Tirar o negócio de um colega e passar de SDR para SDR continuam sendo do gerente
(pela troca de "Responsável").

A rota (`app/api/v1/leads/[id]/passar-ao-vendedor/route.ts`) não escreve nada por
conta própria. Cada pedaço passa pela porta que já existe:

1. o **negócio**: `updateLeadHandler`, a mesma edição do card (linha do tempo,
   evento `lead.updated` e auditoria `lead.updated`);
2. a **carteira** do cliente: `fn_definir_carteira_do_cliente` com o SDR como
   ator. A função confere a posse dele. Se o cliente estiver na carteira de outra
   pessoa, ele fica lá, e a resposta diz `carteira: "nao_passou"`;
3. as **conversas abertas** que seguem com o SDR: `fn_conversation_assign`
   (`transfer`, o botão Transferir), com aviso ao vendedor
   (`conversation.transferred`) e linha na linha do tempo.

O negócio passa mesmo que a carteira ou uma conversa não passe. A tela avisa o
SDR quando o cliente ficou na carteira de outra pessoa. Componentes:
`components/kanban/KanbanCardActions.tsx`; hooks `useVendedoresDoSdr` e
`usePassarAoVendedor` em `hooks/sdr/useSdr.ts`.

A condição de `recusaDoNegocio` (negócio aberto, com o SDR ou sem dono humano)
vai também **no próprio `UPDATE`** (`somenteSe` em `updateLeadHandler`). Se outro
SDR ou o gerente mexer no negócio entre a leitura e a gravação, nenhuma linha
casa e a resposta é 409 `state_conflict`: a segunda passagem não sobrescreve o
dono que a primeira acabou de escolher, e nada mais (carteira, conversas,
auditoria) é tocado.

## A tela Leads sem vendedor

`/app/sdr` é a fila do SDR: os negócios abertos que estão com ele ou sem dono
humano (na fila ou com um agente de IA), do mais antigo para o mais novo, com
a escolha do vendedor e o botão **Passar** em cada linha. É a mesma passagem do
menu do card, sem precisar abrir o funil.

- **Porta:** o hub "Ver tudo em CRM" e a busca (⌘K), só com a função SDR ligada
  na empresa (`capacidade: "sdr"` em `lib/navigation/catalogo.ts`). Não há item
  no menu lateral, pelo mesmo critério de Cold Call.
- **Quem vê:** SDR ativo. Quem abre a tela sem ser SDR lê o porquê e o que pedir
  ao administrador; quem recusa de verdade é a rota, não o menu.
- **O que aparece:** exatamente o que o **Passar** aceita, porque a lista usa a
  régua de `recusaDoNegocio`. A leitura é pela sessão do SDR: a RLS de
  `crm_leads` decide o que ele enxerga, como no funil.
- **Filtros:** Todos, Comigo, Na fila e Com a IA, com a contagem de cada um.
- **Teto:** 200 negócios. Passou disso, a tela avisa que mostra os 200 mais
  antigos. Negócio de funil arquivado não entra, e sai **antes** do teto.
- **Falha de leitura** aparece como erro com "Tentar de novo", nunca como "você
  não é SDR" nem como "não há vendedor".

Fonte: `lib/sdr/negocios-do-sdr.ts`, `app/api/v1/sdr/negocios/route.ts`,
`app/app/sdr/`, hook `useNegociosDoSdr`.

## API

Todas pela sessão (cookie). Ainda não aceitam `Bearer dsk_...`
(`lib/api/auth-dual.ts` não foi ligado nelas).

| Método e rota | Papel | Função desligada | Resposta |
|---|---|---|---|
| `GET /api/v1/settings/sdr` | viewer+ | responde | `{ enabled, distribution: { flow: "sdr" \| "team", active_sdrs } }` |
| `PATCH /api/v1/settings/sdr` `{ enabled }` | admin | — | `{ enabled }`; 409 `conflict` se outra escrita correu |
| `GET /api/v1/sdr/assignments` | manager+ | 409 `sdr_disabled` | `[{ user_id, full_name, role, assigned_since, active, inactive_reason }]`, `meta.total` |
| `POST /api/v1/sdr/assignments` `{ user_id }` | admin | 409 `sdr_disabled` | 201 marcou · 200 já era · 404 · 409 revogado · 422 `sdr_role_ineligible` |
| `DELETE /api/v1/sdr/assignments/{user_id}` | admin | 409 `sdr_disabled` | 200 (idempotente) · 404 |
| `GET /api/v1/sdr/permissions[?user_id=]` | o próprio: viewer+; outro: manager+ | responde | ver abaixo |
| `GET /api/v1/sdr/vendedores` | agent+ | responde (`pode_passar: false`) | `{ user_id, pode_passar, motivo, vendedores: [user_id] }` |
| `GET /api/v1/sdr/negocios` | agent+ e SDR ativo | 409 `sdr_disabled` | `[{ id, title, value_cents, currency, created_at, pipeline_name, stage_name, contact_name, situacao: "comigo" \| "fila" \| "ia", owner_agent_name, … }]`, `meta.total`, `meta.has_more` (teto de 200) · 403 `sdr_handoff_forbidden` |
| `POST /api/v1/leads/{id}/passar-ao-vendedor` `{ user_id }` | agent+ e SDR ativo | 409 `sdr_disabled` | `{ lead_id, owner_user_id, carteira, carteira_motivo, conversas_passadas, conversas_que_ficaram }` · 403 `sdr_handoff_forbidden` · 404 · 409 `lead_not_open` · 409 `state_conflict` (o negócio mudou no meio) · 422 |

```json
{
  "data": {
    "user_id": "…",
    "role": "agent",
    "membership_active": true,
    "sdr": {
      "feature_enabled": true,
      "assigned": true,
      "assigned_since": "2026-11-10T12:00:00.000Z",
      "active": true,
      "inactive_reason": null
    },
    "permissions": ["sdr.leads.prospect", "sdr.leads.qualify", "sdr.leads.handoff"]
  }
}
```

`inactive_reason` traz a primeira condição que falhou: `feature_disabled`,
`membership_revoked`, `role_below_minimum` ou `not_assigned`.

Auditoria: `sdr.settings_changed`, `sdr.assigned`, `sdr.unassigned` e
`sdr.lead_handed_off` (o vendedor, se a carteira passou e quantas conversas). A chamada
idempotente que não muda nada não audita.

## O que ainda não existe

- **Relatório "por SDR".**
- **Passagem pelo dossiê e pela Inbox.** Hoje o "Passar para vendedor" está no
  menu do card do funil e na tela Leads sem vendedor. Por regra, a automação "Atribuir a um atendente" (#3514)
  continua disponível.
- **Lead que chega sem conversa** (formulário, API, importação) não passa pelo
  rodízio de conversas e, portanto, não pelo fluxo SDR.
- **Bearer token** nessas rotas.
- **Aviso de negócio parado com quem deixou de ser SDR.** Desmarcar um SDR tira
  só a marca: os negócios que estavam com ele continuam com ele, e o gerente
  reatribui pelo campo Responsável.

## Laço de retorno (sistema vivo)

- **Entrada:** admin pela tela de Equipe (ou pela API). **Saída:** os leads
  novos entregues só aos SDRs (worker de roteamento), a coluna SDR da tabela, o
  fluxo em vigor no cartão, `GET /api/v1/sdr/permissions` e a lista.
- **Log:** `api_audit_log`, filtrável no painel de auditoria (o vocabulário é
  derivado de `lib/audit/actions.ts`).
- **Quando erra:** um SDR que parou de valer não some. A tabela mostra o motivo
  na linha dele (e a API devolve `active: false` com `inactive_reason`), e é por
  ali que quem gerencia descobre por que ele deixou de valer.
