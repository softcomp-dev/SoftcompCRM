# Integração com ERP pela API REST — o que existe e o que falta

> Para quem vai planejar ou construir a integração de um ERP (ou outro sistema
> de gestão) que **controla o fluxo do CRM**: cadastra o cliente, abre o
> negócio quando nasce o pedido, avança as etapas conforme o pedido anda e
> recebe de volta o que acontece no CRM.
>
> Contrato de cada rota que já existe: [`openapi.yaml`](openapi.yaml), aberto na
> própria instalação em `/docs` (Swagger com botão de testar). Este documento é
> o mapa: o que já dá para fazer, o que falta e em que ordem construir.

## Estado medido em 13/11/2026 — e como medir de novo

As listas abaixo envelhecem a cada rota convertida. A pergunta "quais rotas já
aceitam token?" se responde por comando, não por esta página:

```bash
git grep -lE "resolveAuthDual|validateBearerToken|extractBearer" -- 'app/api/v1/**/route.ts'
```

Uma rota só aceita token quando as **duas** coisas valem: o handler resolve o
`Bearer dsk_…` (`lib/api/auth-dual.ts`) **e** o caminho está em
`lib/auth/public-paths.ts` — sem a segunda, o proxy devolve 401 antes de o
token chegar à rota (ver `CLAUDE.md`, "Auth dual").

## O fluxo que o ERP precisa controlar

```
ERP                                   CRM
───                                   ───
cliente novo/alterado  ──────────▶  contato        (criar, achar, atualizar)
pedido criado          ──────────▶  negócio        (criar no funil, com o nº do pedido)
pedido muda de fase    ──────────▶  etapa          (mover; ganho = faturado, perda = cancelado)
pedido muda de valor   ──────────▶  negócio        (atualizar valor e campos)
                       ◀──────────  eventos        (negócio criado, mudou de etapa, ganho,
                                                     perdido, atribuído, mensagem recebida)
consulta de estado     ──────────▶  negócio        (ler etapa, dono, valor, status)
```

## O que já existe por token

Todas: `Authorization: Bearer dsk_…`, organização tirada do token (nunca do
corpo), auditoria com o token como ator, teto de 30 escritas por minuto por
token e 600 por organização (contado por recurso).

| Para quê | Rota | Escopo / papel do token | Observação |
|---|---|---|---|
| Descobrir funis | `GET /api/v1/pipelines` | `mcp:read` · agent | Traz `settings`, onde moram os campos personalizados do funil. Conta no teto. |
| Descobrir etapas | `GET /api/v1/pipelines/{id}/stages` | `mcp:read` · agent | Traz `is_won` / `is_lost`. Guarde os ids. |
| Achar contato | `GET /api/v1/contacts?search=` | `mcp:read` · viewer | Por nome, e-mail ou telefone. |
| **Criar contato** | `POST /api/v1/contacts` | `mcp:write` · agent | Repetido (telefone, e-mail ou CPF) → 409 `contact_exists` com o id existente. Aceita `Idempotency-Key`. |
| **Criar negócio** | `POST /api/v1/leads` | `mcp:write` · agent | Recusa etapa de ganho/perda e etapa ou funil arquivado (422). Aceita `Idempotency-Key`. |
| **Mudar etapa** | `POST /api/v1/leads/{id}/move` | `mcp:write` · agent | Valem as regras da tela: campos exigidos (`details.faltando`), motivo de ganho e de perda, reabertura. |
| Atualizar negócio | `PATCH /api/v1/leads/{id}` | `mcp:write` · agent | Valor, título, responsável, campos. Não muda etapa. |
| Enviar mensagem | `POST /api/v1/messages` | ver OpenAPI | WhatsApp, com as regras de janela e anti-banimento. |
| Receber eventos | automação **Chamar webhook** | configurada na tela | 13 eventos (abaixo). Assinatura HMAC, 3 tentativas, botão Reenviar. Guia do receptor: [`docs/integracao/webhooks-de-saida.md`](../integracao/webhooks-de-saida.md). |

Eventos que a automação pode mandar ao ERP (`lib/schemas/webhooks.ts`,
`ENTIDADE_ESPERADA_POR_GATILHO`): `lead.created`, `lead.stage_changed`,
`lead.won`, `lead.lost`, `lead.reopened`, `lead.assigned`, `lead.tag_added`,
`message.received`, `message.failed`, `contact.tag_added`,
`contact.phone_added`, `contact.birthday`, `appointment.created`.

**Com isso já dá para:** cadastrar o cliente sem duplicar, abrir o negócio do
pedido, avançar etapas até ganho ou perda, atualizar o valor e receber de volta
cada mudança. **Ainda não dá para:** ler o negócio, achá-lo pelo número do
pedido, nem sincronizar o que mudou no CRM sem depender do webhook.

## O que falta, em ordem de prioridade

Cada item diz o que existe hoje, o que construir e por quê. "Converter" quer
dizer que a rota já existe para a tela (cookie) e falta só o ramo de token —
padrão de `app/api/v1/leads/route.ts` (`criarPorToken`) e
`app/api/v1/contacts/route.ts`. "Criar" quer dizer que a rota não existe nem
para a tela.

### P0 — sem isto a integração não fecha o laço

**1. Número do pedido no negócio (`external_id`)** — *estender a criação e criar a busca*

- **Hoje:** `crm_leads.external_id` existe, com índice único em
  `(organization_id, source, external_id)` (`uniq_crm_leads_org_source_external`).
  Quem já o usa é o webhook de captação (`/api/v1/webhooks/in/{token}`), que
  descarta o reenvio ou, com a opção do #2316 ligada, atualiza o card. Mas
  `createLeadSchema` (a criação por token) não aceita o campo e nenhuma rota
  busca por ele: o ERP precisa guardar o `id` do CRM do lado dele para tudo.
- **Construir:** aceitar `external_id` no `POST /api/v1/leads`; quando a mesma
  `source` + `external_id` já existir na organização, responder **409
  `lead_exists` com `details.lead_id`** (o mesmo desenho do `contact_exists`).
  Tratar o `23505` do índice como esse 409, nunca 500.
- **Por quê:** é a chave natural do ERP. Com ela, uma retentativa ou uma
  reimportação nunca duplica o negócio, mesmo sem `Idempotency-Key`.

**2. Ler o negócio** — *criar* `GET /api/v1/leads/{id}` e `GET /api/v1/leads/by-external/{source}/{external_id}`

- **Hoje:** não existe `GET` de negócio na API REST, nem para a tela (`app/api/v1/leads/[id]/route.ts` só tem `PATCH`). O MCP tem `crm_get_lead`.
- **Construir:** leitura por id e pelo par `source` + `external_id`, com etapa,
  status (`open`/`won`/`lost`), dono, valor, `custom_fields`, `won_reason`,
  `lost_reason`, `closed_at` e `updated_at`. Escopo `mcp:read`, papel viewer.
  Reaproveitar o handler da tool `crm_get_lead`.
- **Por quê:** o ERP precisa conferir o estado antes de agir (o negócio já foi
  ganho? está em qual etapa?) e reconciliar quando um webhook se perder.

**3. Listar negócios alterados** — *criar* `GET /api/v1/leads`

- **Hoje:** não existe. O MCP tem `crm_list_leads`.
- **Construir:** filtros `pipeline_id`, `stage_id`, `status`, `owner_user_id`,
  `source`, **`updated_since`** (ISO-8601) e paginação por cursor opaco (o
  padrão da casa, como em `GET /api/v1/contacts`). Ordem estável por
  `updated_at, id`.
- **Por quê:** o webhook avisa na hora, mas pode falhar. A varredura por
  `updated_since` é a rede de segurança que torna a sincronização confiável.

**4. Quem pode ser responsável** — *converter* `GET /api/v1/team/assignable`

- **Hoje:** só por cookie. O `PATCH /api/v1/leads/{id}` aceita
  `owner_user_id`, mas o ERP não tem como descobrir os ids dos vendedores.
- **Construir:** ramo de token, escopo `mcp:read`. Devolver `user_id`, nome e
  **e-mail** — o e-mail é o que o ERP tem para casar o vendedor dele com o do CRM.

**5. Ler e atualizar o contato** — *converter* `GET` e `PATCH /api/v1/contacts/{id}`

- **Hoje:** só por cookie. Com o 409 `contact_exists` o ERP recebe o id, mas
  não consegue atualizar endereço, documento ou campos quando o cadastro muda
  no ERP.
- **Construir:** ramo de token nas duas, com `mcp:read` e `mcp:write`. O
  `PATCH` já valida pela régua do país; manter.

### P1 — deixa a integração completa

**6. Ganho e perda com motivo explícito** — *converter* `POST /api/v1/leads/{id}/win` e `/lose`

- **Hoje:** dá para fechar movendo para a etapa de ganho/perda (com
  `won_reason`/`lost_reason`), mas o ERP precisa saber o id dessa etapa em cada
  funil. As rotas `win`/`lose` decidem a etapa sozinhas.
- **Por quê:** "pedido faturado" e "pedido cancelado" viram uma chamada só,
  sem o ERP manter mapa de etapas de fechamento.

**7. Registrar fato na linha do tempo** — *criar* `POST /api/v1/leads/{id}/notes`

- **Hoje:** a linha do tempo (`crm_lead_activities`) só se lê pela tela
  (`GET /api/v1/leads/{id}/timeline`, cookie). O ERP não tem como registrar
  "NF 1234 emitida" ou "boleto vencido" para o vendedor ver.
- **Construir:** nota com tipo de atividade de vocabulário fechado (constante
  compartilhada, como manda a exceção de vocabulário aberto do `CLAUDE.md`) e
  ator = token.

**8. Tarefas para o vendedor** — *converter* `POST /api/v1/tasks`

- **Hoje:** só por cookie.
- **Por quê:** o ERP cria "ligar para cobrar parcela" ou "confirmar entrega"
  ligada ao negócio e ao responsável.

**9. Configurar os webhooks de saída por API** — *converter* `/api/v1/automation-rules`

- **Hoje:** a regra "quando X, chamar webhook" só nasce pela tela.
- **Por quê:** quem instala a integração para vários clientes precisa
  configurar sem entrar em cada CRM. Atenção: a regra guarda URL e segredo; o
  ramo de token exige papel admin e o anti-SSRF que a tela já aplica.

### P2 — conforme a integração pedir

| Item | Hoje | Construir |
|---|---|---|
| Itens do pedido no negócio | Produtos e propostas só por cookie; não há item ligado ao negócio fora da proposta | Decidir antes: item mora no negócio ou na proposta (doutrina DIRC). Não criar tabela nova sem essa decisão |
| Empresas (B2B) | `companies` só por cookie, e só com o módulo `crm_b2b` | Converter, se o ERP for B2B |
| Etiquetas | Tool MCP `crm_manage_tags`; REST só por cookie | Converter `contact-tags` / tags do negócio |
| Anexar documento (NF, contrato) | `POST /api/v1/leads/{id}/attachments` só por cookie | Converter, com o mesmo teto de tamanho do upload |
| Webhook de entrada genérico | Já existe (`/api/v1/webhooks/in/{token}`), com `external_id` e atualização do card existente (#2316) | Nada. Serve como atalho para criar/atualizar negócio a partir do pedido, mas responde menos (não diz por que recusou) e não lê nada; para controle do fluxo, prefira as rotas acima |

## Regras para cada rota nova ou convertida

Valem para todo item acima; são as mesmas de `criarPorToken` em
`app/api/v1/leads/route.ts`:

1. **Organização da linha do token**, nunca do corpo; todo acesso com o client
   de serviço filtra `organization_id` (anti-pattern 10 do `CLAUDE.md`).
2. **Entrada em `lib/auth/public-paths.ts`** ancorada com `$` e com o id em
   forma de UUID — sem ela o proxy devolve 401. Teste que libera o caminho e
   **não** libera os irmãos.
3. **Escopo e papel** declarados (`mcp:read` para leitura, `mcp:write` para
   escrita; papel mínimo agent na escrita).
4. **Teto de escrita** (`tetoDeEscritaDoToken`) em toda escrita, e
   **`Idempotency-Key`** (`lib/api/idempotency.ts`) em todo `POST` de criação.
5. **Erro para quem integra:** recusa de negócio (4xx) com `details`; falha
   interna (5xx) sem texto do banco — `falhaDoHandlerParaToken` em
   `lib/api/integracao-por-token.ts`.
6. **`requireSupportWrite`** antes do efeito e **auditoria** com o token como ator.
7. **OpenAPI** atualizado no mesmo PR (`docs/api/openapi.yaml`), com exemplo
   que funciona se copiado, e fragmento em `.changes/`.

## O que este documento não mediu

- Volume: os tetos (30 escritas/min por token, 600 por organização) não foram
  medidos contra a carga real de um ERP. Um ERP que importa milhares de pedidos
  de uma vez vai precisar de uma rota em lote ou de um teto próprio — decidir
  quando houver o caso.
- As tools do MCP citadas como base (`crm_get_lead`, `crm_list_leads`) foram
  identificadas pelo nome; o reaproveitamento do handler delas não foi testado.
