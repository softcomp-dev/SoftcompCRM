# Integração com ERP pela API REST — o mapa das rotas

> Para quem vai planejar ou construir a integração de um ERP (ou outro sistema
> de gestão) que **controla o fluxo do CRM**: cadastra o cliente, abre o
> negócio quando nasce o pedido, avança as etapas conforme o pedido anda e
> recebe de volta o que acontece no CRM.
>
> Contrato de cada rota que já existe: [`openapi.yaml`](openapi.yaml), aberto na
> própria instalação em `/docs` (Swagger com botão de testar). Este documento é
> o mapa: o que o ERP faz, por qual rota, e o que ficou de fora.

## Estado medido em 13/11/2026 (depois das rotas do ERP) — e como medir de novo

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

## O que existe por token

Todas: `Authorization: Bearer dsk_…`, organização tirada do token (nunca do
corpo), auditoria com o token como ator. Escrita e leitura contam no teto de 30
chamadas por minuto por token e 600 por organização, por recurso. Todo `POST`
de criação aceita `Idempotency-Key`. O contrato de cada uma está em `/docs`.

**Ciclo do pedido (negócio)**

| Para quê | Rota | Token |
|---|---|---|
| Descobrir funis e etapas | `GET /api/v1/pipelines`, `GET /api/v1/pipelines/{id}/stages` | `mcp:read` · agent |
| Criar o negócio com o nº do pedido | `POST /api/v1/leads` (`external_id` + `source`; repetido → 409 `lead_exists` com o id) | `mcp:write` · agent |
| Ler o negócio | `GET /api/v1/leads/{id}` | `mcp:read` · viewer |
| Achar pelo nº do pedido | `GET /api/v1/leads/by-external/{source}/{external_id}` | `mcp:read` · viewer |
| Sincronizar o que mudou | `GET /api/v1/leads?updated_since=…` (ordem estável, cursor) | `mcp:read` · viewer |
| Atualizar valor, título, responsável, campos | `PATCH /api/v1/leads/{id}` | `mcp:write` · agent |
| Mudar etapa | `POST /api/v1/leads/{id}/move` | `mcp:write` · agent |
| Faturado / cancelado | `POST /api/v1/leads/{id}/win`, `/lose` (escolhem a etapa sozinhas) | `mcp:write` · agent |
| Registrar fato para o vendedor | `POST /api/v1/leads/{id}/notes` | `mcp:write` · agent |
| Anexar NF, contrato | `GET`/`POST /api/v1/leads/{id}/attachments`, `GET …/{anexo}/media` | read · viewer / write · agent |
| Itens do pedido | `GET`/`POST /api/v1/proposals`, `GET`/`PATCH /api/v1/proposals/{id}` (rascunho) | read · viewer / write · agent |

**Cliente, equipe e rotina**

| Para quê | Rota | Token |
|---|---|---|
| Achar contato | `GET /api/v1/contacts?search=` | `mcp:read` · viewer |
| Criar contato | `POST /api/v1/contacts` (repetido → 409 `contact_exists` com o id) | `mcp:write` · agent |
| Ler e atualizar a ficha | `GET`/`PATCH /api/v1/contacts/{id}` | read · viewer / write · agent |
| Etiquetas em uso | `GET /api/v1/contact-tags` | `mcp:read` · viewer |
| Empresas (módulo CRM B2B) | `GET`/`POST /api/v1/companies`, `GET`/`PATCH /api/v1/companies/{id}` | read · viewer / criar · manager / editar · agent |
| Quem pode ser responsável (com e-mail) | `GET /api/v1/team/assignable` | `mcp:read` · viewer |
| Tarefas | `GET`/`POST /api/v1/tasks` | read · viewer / write · agent |
| Mensagem no WhatsApp | `POST /api/v1/messages` | ver OpenAPI |

**De volta para o ERP**

| Para quê | Rota | Token |
|---|---|---|
| Configurar o webhook de aviso | `GET`/`POST /api/v1/automation-rules`, `PATCH`/`DELETE /api/v1/automation-rules/{id}` (a regra nasce pausada; o segredo nunca volta) | **admin** |
| Receber os eventos | a regra "Chamar webhook": assinatura HMAC, 3 tentativas, Reenviar. Guia: [`docs/integracao/webhooks-de-saida.md`](../integracao/webhooks-de-saida.md) | — |

Eventos que a regra pode mandar ao ERP (`lib/schemas/webhooks.ts`,
`ENTIDADE_ESPERADA_POR_GATILHO`): `lead.created`, `lead.stage_changed`,
`lead.won`, `lead.lost`, `lead.reopened`, `lead.assigned`, `lead.tag_added`,
`message.received`, `message.failed`, `contact.tag_added`,
`contact.phone_added`, `contact.birthday`, `appointment.created`.

## O que ficou de fora por decisão — e o que ainda falta

Fora por decisão (cada um recusa Bearer no handler, porque o proxy libera o
caminho e não o método):

- **Apagar** contato, empresa, proposta ou anexo. Contato tem fluxo de LGPD
  (anonimização) na tela; apagar por integração é irreversível demais.
- **Enviar a proposta ao cliente**, gerar o PDF, registrar a decisão e revisar.
  São efeitos para fora, com a marca da empresa; ficam com quem opera a tela.
- O histórico de execuções das automações (`/automation-rules/runs`).

Ainda falta, quando o caso aparecer:

- **Volume.** Os tetos (30 por minuto por token) servem à operação do dia a dia.
  Um ERP que importa milhares de pedidos de uma vez precisa de rota em lote ou
  de teto próprio.
- **Reabertura em `win`/`lose`.** As duas rotas (tela e token) passam por
  `encerraDemanda`, que não aplica a regra de reabertura do funil: um negócio
  perdido passa a ganho. Quem depende dessa regra usa `move`, que a aplica.
  Mudar isso muda a tela também, e é decisão de produto.
- **Empresas sem cursor.** O handler pagina só por `limit` (até 100) e
  `has_more`; para sincronizar uma base grande de empresas, falta cursor.
- **Auditoria de empresas por token** grava duas linhas: o handler
  (`lib/crm-b2b/companies-handler.ts`) só aceita ator usuário, e a rota grava
  a segunda com o token. O certo é o handler aceitar o token como ator.

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

## O que não foi medido

- **Banco e Storage reais.** Cada rota foi provada com banco em memória que
  aplica os filtros (organização inclusive) e com o typecheck; nenhuma rodou
  contra o Postgres e o Storage de uma instalação. Em particular: as RPCs de
  cifra (CPF, segredo do webhook) chamadas pelo client de serviço, o índice
  único de `external_id` sob corrida e o cursor de propostas além da primeira
  página.
- **Carga.** Os tetos não foram medidos contra o volume real de um ERP.
- **O Swagger em `/docs`** foi validado como YAML; o botão "Testar" de cada
  rota nova não foi exercitado no navegador.
