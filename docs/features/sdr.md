# Função SDR

SDR (Sales Development Representative) é quem faz a pré-venda: aborda, qualifica
e passa o lead pronto ao closer. Aqui a função é **por organização** (cada
empresa liga ou não) e **por membro** (cada um é marcado ou não).

## SDR não é papel

Os papéis (`viewer` < `agent` < `manager` < `admin`) são uma escada de **poder**,
lida pela RLS e por `requireRole`. SDR é uma **função comercial** que se soma ao
papel, e por isso não entrou na escada: nenhuma policy mudou, e um `manager` SDR
continua com tudo o que um `manager` tem.

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

⚠️ **As três `sdr.leads.*` são contrato, ainda sem consumidor.** Nenhuma tela,
rota de lead ou roteamento as lê hoje. Quem acessa cada lead continua decidido
pelo papel e pela visibilidade de sempre. Para conferir sem confiar nesta linha:

```bash
git grep -n "sdr.leads" -- app lib components ':!lib/sdr' ':!*.test.ts'
```

## API

Todas pela sessão (cookie). Ainda não aceitam `Bearer dsk_...`
(`lib/api/auth-dual.ts` não foi ligado nelas).

| Método e rota | Papel | Função desligada | Resposta |
|---|---|---|---|
| `GET /api/v1/settings/sdr` | viewer+ | responde | `{ enabled }` |
| `PATCH /api/v1/settings/sdr` `{ enabled }` | admin | — | `{ enabled }`; 409 `conflict` se outra escrita correu |
| `GET /api/v1/sdr/assignments` | manager+ | 409 `sdr_disabled` | `[{ user_id, full_name, role, assigned_since, active, inactive_reason }]`, `meta.total` |
| `POST /api/v1/sdr/assignments` `{ user_id }` | admin | 409 `sdr_disabled` | 201 marcou · 200 já era · 404 · 409 revogado · 422 `sdr_role_ineligible` |
| `DELETE /api/v1/sdr/assignments/{user_id}` | admin | 409 `sdr_disabled` | 200 (idempotente) · 404 |
| `GET /api/v1/sdr/permissions[?user_id=]` | o próprio: viewer+; outro: manager+ | responde | ver abaixo |

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

Auditoria: `sdr.settings_changed`, `sdr.assigned` e `sdr.unassigned`. A chamada
idempotente que não muda nada não audita.

## O que ainda não existe

- **Tela.** Ligar a função e marcar SDRs só pela API. A tela entra em
  Configurações › Equipe e precisa da porta no `NAV_CATALOG`.
- **Consumidor das `sdr.leads.*`**: roteamento de lead novo só para SDRs, filtro
  de relatório "por SDR" e passagem SDR → Closer lendo a marca. Hoje a passagem
  é a automação de troca de responsável (#3514), escolhendo a pessoa pelo nome.
- **Bearer token** nessas rotas.

## Laço de retorno (sistema vivo)

- **Entrada:** admin pela API. **Saída:** `GET /api/v1/sdr/permissions` e a lista.
- **Log:** `api_audit_log`, filtrável no painel de auditoria (o vocabulário é
  derivado de `lib/audit/actions.ts`).
- **Quando erra:** um SDR que parou de valer não some. A lista o mostra como
  `active: false` com o motivo, e é por ali que quem gerencia descobre por que
  ele deixou de valer.
