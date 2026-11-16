# Multiempresa: Vínculos, Visão consolidada e transferência entre empresas

Três peças para quem trabalha em mais de uma empresa da mesma instalação (matriz e
filiais, unidades de uma rede, uma agência com vários clientes):

1. **Vínculos**: o dono da instalação escolhe quais empresas cada conta acessa.
2. **Visão consolidada**: funil, conversas e contatos de várias empresas numa tela só.
3. **Transferir para outra empresa**: passar um negócio de uma empresa para outra.

Nada muda para quem tem uma empresa só. Não há variável de ambiente nova. As duas
primeiras peças não têm migration, e a terceira reaproveita o desenho da troca de funil.

## 1. Vínculos (painel do dono)

**Onde:** Painel do dono (`/admin`) › Clientes › **Vínculos** (`/admin/vinculos`). Só
para quem está em `platform_admins`.

A tela lista as contas da instalação. Para cada conta ela mostra todas as empresas, e o
dono marca quais a conta acessa (uma, algumas ou todas) e com que papel em cada uma.
O estado de cada empresa aparece como **Vinculada**, **Convite pendente** ou
**Revogada**.

- **O vínculo vale na hora, sem convite.** O convite existe para provar que o e-mail é
  de quem vai entrar; aqui a conta já existe e já provou o e-mail, e quem decide é o
  dono da instalação.
- **Convite pendente não é acesso.** Uma empresa em que a conta só tem convite não
  aceito aparece como "Convite pendente". Marcar e salvar dá o acesso com o papel do
  seletor.
- **Remarcar uma empresa revogada usa o papel do seletor**, nunca o papel antigo. Assim
  um ex-administrador não volta administrador sem que alguém tenha escolhido isso.
- **Tirar o acesso tem o mesmo efeito da Equipe** (`lib/team/revogar-vinculo.ts`): as
  conversas abertas da pessoa voltam para a fila.
- **O último administrador de uma empresa não sai.** O banco confere isso no momento da
  gravação, então duas remoções simultâneas não deixam a empresa sem administrador. Um
  convite de administrador não aceito não conta como "outro administrador".

| Peça | Artefato |
|---|---|
| Regra (pura) | `lib/admin/vinculos.ts` (`planejarVinculos`, `rebaixariaUltimoAdmin`), `lib/admin/vinculos-diff.ts` |
| API | `GET /api/v1/admin/vinculos/contas`; `GET/POST/PATCH/DELETE /api/v1/admin/users/[id]/vinculos` (`requirePlatformAdmin`) |
| Tela | `app/admin/(protected)/vinculos/` e o atalho na ficha do usuário (`/admin/users/[id]`) |
| Menu | `lib/admin/navegacao.ts` (grupo Clientes) |
| Auditoria | `member.linked`, `member.reactivated`, `member.role_changed` e a revogação de sempre |

## 2. Visão consolidada

**Onde:** CRM › hub "Ver tudo em CRM" › **Visão consolidada** (`/app/consolidado`), e
**Ver todas juntas** no seletor de empresa do cabeçalho
(`components/shell/TenantSwitcher.tsx`).

Três abas: **Funil**, **Conversas** e **Contatos**. O seletor **Empresas na visão**
estreita o conjunto (`?empresas=a,b`); sem filtro entram todas as empresas da pessoa.

- **Quem entra:** só as empresas em que a pessoa é membro ativo (vínculo aceito, não
  revogado, empresa operante), no máximo 200. O filtro da URL só estreita esse conjunto:
  um id que não é da pessoa some em silêncio, sem confirmar que a empresa existe. A RLS
  libera tudo para o platform admin, por isso o escopo é decidido pelos vínculos, e toda
  consulta filtra `organization_id in (escopo)` explicitamente
  (`lib/consolidado/escopo.ts`).
- **Colunas do funil:** etapas com o **mesmo nome** viram uma coluna só, ignorando
  maiúsculas, acentos e espaços repetidos. Ganho e perda se juntam pela marca
  (`is_won`/`is_lost`), não pelo nome, e ficam sempre no fim. As colunas abertas se
  ordenam pela posição relativa média da etapa no próprio funil
  (`lib/consolidado/colunas.ts`). Cada card mostra o nome da empresa.
- **Teto:** cada etapa mostra os seus **100** primeiros negócios
  (`TETO_DE_NEGOCIOS_POR_ETAPA`), e a coluna que tem mais avisa. Conversas e Contatos
  juntam a primeira página de cada empresa e avisam quando a lista foi truncada
  (`lib/consolidado/juntar.ts`).
- **Arrastar:** o card só vai para etapas do funil dele, e só em empresa em que a
  pessoa é pelo menos `agent`. Se a etapa exige dados (motivo do ganho, campos
  obrigatórios), abre a mesma janela do funil de cada empresa. Se a etapa exige anexo,
  a tela oferece **Abrir o negócio**. Depois do movimento a tela volta a mostrar o que
  está gravado.
- **Abrir** um card, uma conversa ou um contato de outra empresa troca a empresa ativa
  antes de abrir.

| Peça | Artefato |
|---|---|
| Regras (puras) | `lib/consolidado/escopo.ts`, `colunas.ts`, `juntar.ts`, `em-paralelo.ts` |
| Leitura dos vínculos | `lib/consolidado/servidor.ts` |
| API | `GET /api/v1/consolidado/funil`, `POST /api/v1/consolidado/funil/mover` (`requireRole("agent", { organizationId })`), `GET /api/v1/consolidado/conversas`, `GET /api/v1/consolidado/contatos` |
| Tela | `app/app/consolidado/` |
| Menu | `lib/navigation/catalogo.ts` (hub do CRM; fora do sidebar, que está no limite de altura) |
| Auditoria | o movimento grava `lead.moved` na empresa do card |

## 3. Transferir um negócio para outra empresa

**Onde:** menu "⋯" do card no funil › **Transferir para outra empresa**. Você escolhe a
empresa, o funil e, se quiser, a etapa de entrada.

- **Quem vê o item:** quem é `manager` ou acima na empresa do negócio e pelo menos
  `agent` na empresa de destino. Cada papel é conferido na própria empresa.
- **O que acontece:** o negócio é **recriado** no destino com o mesmo título, valor,
  etiquetas e campos do negócio. O contato no destino é o mesmo cliente, achado pelo
  telefone e depois pelo e-mail, e só é cadastrado se a empresa de destino ainda não o
  conhece (`source = 'transferencia_entre_empresas'`). A origem encerra com o motivo
  `moved_to_another_pipeline`, que as métricas de atendente não contam como perda. A
  linha do tempo dos dois lados registra de onde veio e para onde foi
  (`source_metadata.transferido_de` / `transferido_para`).
- **O que fica na origem:** conversas e mensagens (o canal é da origem), tarefas,
  anexos, propostas, CPF, consentimento e campos personalizados do contato. O dono que é
  agente de IA também fica: o dono humano continua dono no destino se também atua lá; se
  não, o negócio nasce sem dono.

| Peça | Artefato |
|---|---|
| Regra (pura) | `lib/leads/transferir-entre-empresas.ts` |
| API | `GET/POST /api/v1/leads/[id]/transferir-empresa` |
| Tela | `components/kanban/TransferToOrganizationDialog.tsx`, item em `KanbanCardActions.tsx` |
| Regra de negócio | catálogo, seção da troca de funil, item "Entre EMPRESAS" |
| Auditoria | `lead.transferred_to_organization` (origem) e `lead.received_from_organization` (destino) |

## Laço de retorno

- Vínculo errado: o dono corrige na mesma tela, e a auditoria mostra quem deu o acesso.
- Card que não pode ir para a etapa: a recusa diz o motivo, e o diálogo de campos ou o
  botão **Abrir o negócio** levam ao que falta.
- Transferência para a empresa errada: o negócio de origem fica encerrado e visível com
  o ponteiro para o destino, e dá para transferir de volta pelo mesmo menu.
