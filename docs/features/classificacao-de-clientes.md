# Classificação de clientes (ativo, pré-inativo, inativo)

Cada contato é classificado pela data da **última venda ganha**: o `closed_at`
mais recente entre os negócios com `status = 'won'`. Um ganho parcial também
conta, porque é um ganho.

| Faixa | Regra (prazos padrão) |
|---|---|
| `ativo` | última venda há até `classificacao_ativo_dias` (90) |
| `pre_inativo` | até `classificacao_pre_inativo_dias` (180) |
| `inativo` | depois disso |
| `sem_compra` | nenhum negócio ganho |

## Onde mora cada peça

| Peça | Artefato |
|---|---|
| Fonte | `crm_leads` (status `won`, `closed_at`) |
| Dado derivado | `contacts.last_won_at`, recalculado pelo gatilho `trg_crm_lead_ultima_venda` em todo ganho, reabertura, troca de contato ou exclusão (migration 9257) |
| Prazos | `organizations.classificacao_ativo_dias` / `classificacao_pre_inativo_dias`, com CHECK 1..3650 e pré > ativo |
| Regra | `lib/clientes/classificacao.ts`: `classificar`, `cortesDaClassificacao`, `filtroOrDaClassificacao` |
| API | `GET /api/v1/contacts?classificacao=` (repetível, OU); cada contato traz `last_won_at` e `classificacao` |
| Tela | selo na lista e na ficha; filtro "Classificação" na lista e na exportação |
| Configuração | Configurações › Organização › Classificação de clientes (`atualizarClassificacaoDeClientes`, auditada) |
| Campanha | critério `classificacoes` do `audience_filter` |
| Aviso | cron diário `classificacao-de-clientes` → `agent_inbox_items.kind = 'client_pre_inactive'` (ref `contact`) |

A **faixa não é gravada**: ela muda com o passar do tempo sem que nada aconteça,
e uma coluna sincronizada por cron seria o anti-pattern 5. Só a data da venda é
materializada, porque filtro e campanha precisam de índice.

## O aviso de pré-inativo

- Avisa quem cruzou o prazo de ativo nos últimos **7 dias**. A janela cobre
  rodadas perdidas e evita a rajada da primeira execução depois da atualização.
- Gera um aviso por venda. A marca `contacts.pre_inativo_avisado_para` guarda o
  `last_won_at` já avisado. Uma compra nova seguida de novo esfriamento gera um
  aviso novo.
- O texto não leva o nome do cliente, por causa da LGPD: o item da Central não
  entra na cascata de anonimização.
- Ficam fora do aviso: organização parada, contato anonimizado, pessoal,
  fornecedor e cadastro mesclado.

## Laço de retorno

Se o prazo estiver errado para o negócio, a equipe percebe pelo volume de avisos
ou pelo selo, e quem administra ajusta o prazo na tela. A mudança fica na
auditoria (`crm.classificacao_de_clientes_configurada`) e reclassifica todo
mundo na próxima leitura.
