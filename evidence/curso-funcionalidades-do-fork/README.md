# Curso: aulas das funcionalidades do fork (16/11/2026)

## Situação em 17/11/2026: capturado e publicado (só português)

A captura foi feita numa bancada descartável no servidor 10.0.0.10 (Supabase local
próprio, app da imagem publicada, worker parado), apagada depois. Resultado:

- **Curso inteiro em português:** 89 módulos e as jornadas dos 10 nichos, 1.650 fotos.
  As fotos são da v1.104.14; a aula de Atualização é da v1.104.19, porque precisa da
  seção da versão no CHANGELOG, que o fork só passou a escrever na v1.104.17.
- **Espanhol fora**, por decisão do dono do fork; o catálogo continua no repositório.
- **Publicado** na Release `curso-2026-11-17` (não-latest) e no GitHub Pages do fork,
  aberto pela aba Curso do CRM (ver [`docs/features/curso-no-crm.md`](../../docs/features/curso-no-crm.md)).
- **Aulas corrigidas pela captura:** as do fork e as antigas que as telas de hoje não
  acompanhavam (funil, etapas, inbox, contatos, organização, aviso no WhatsApp,
  distribuição, marca, memória, respostas rápidas, tags, tarefas), mais o capturador
  das jornadas, que não achava card de negócio ganho.

### Recaptura com a marca SoftcompCRM (17/11/2026, à tarde)

O curso foi fotografado de novo, inteiro, com a marca da Softcomp aplicada como marca
da instalação (`CURSO_MARCA*` na semente; ver `curso/marca.ts`):

- **Fotos:** v1.104.20, 89 módulos e as jornadas dos 10 nichos, 1.650 fotos, com o logo
  da Softcomp no menu e o nome SoftcompCRM.
- **Site:** título "Curso SoftcompCRM", logo no cabeçalho e dourado `#c9982f` no lugar
  do verde.
- **Publicado** na Release `curso-2026-11-17-b` (não-latest), que substitui a
  `curso-2026-11-17` no GitHub Pages. Cópia das fotos fora do repositório, em
  `C:\projetos\SoftcompCRM-curso-fotos`.
- **Aulas ajustadas:** Marca (o menu mostra o logo, não o nome em texto) e Memória
  (o quadro é remontado depois de carregar).

O texto abaixo é o roteiro escrito antes da captura, mantido como registro.

Aulas escritas a partir do código, **sem captura**. A máquina onde foram escritas
não tem Docker, e o runbook proíbe fotografar o CRM de um cliente. Este arquivo é o
roteiro para quem tiver a bancada ([`docs/runbooks/atualizar-curso.md`](../../docs/runbooks/atualizar-curso.md)).

## O que entrou

| Módulo | Lições novas | Semente |
|---|---|---|
| `equipe` | `funcao-sdr` | (a de `sdr` zera `sdr_since`) |
| `sdr` (novo, `/app/sdr`) | `conhecendo-a-tela`, `passar-pelo-funil` | `curso/semear/sdr.ts` |
| `contatos` | `classificacao-do-cliente`, `historico-de-atendimento` | `curso/semear/contatos.ts` |
| `organizacao` | `classificacao-de-clientes` | — |
| `campanhas` | `campanhas-publico-por-classificacao` | `curso/semear/campanhas.ts` |
| `funis` | `ganho-parcial-e-cor-do-cartao`, `numero-da-cotacao-ou-do-pedido` | `curso/semear/funis.ts` |
| `consolidado` (novo, `/app/consolidado`) | 4 da visão + `transferir-para-outra-empresa` | `curso/semear/consolidado.ts` |
| `admin-vinculos` (novo, `/admin/vinculos`) | `dar-acesso-a-varias-empresas`, `mudar-papel-ou-tirar-acesso` | `curso/semear/admin-vinculos.ts` |
| `conexoes` | `telefone-atendimento-do-time` | — |
| `trunk-sip` | passos do quadro "No servidor" | `curso/semear/trunk-sip.ts` |
| `atualizacao` | passo "Buscar atualização" | `curso/semear/atualizacao.ts` |
| `api-tokens` | passo do link para a documentação | — |
| `documentacao-da-api` (novo, `/app/docs`) | `conhecendo-a-tela` | — |

Também foram corrigidas aulas antigas que quebrariam na próxima captura: os cards do
funil (`funis`, `etapas-do-funil`, `inbox`), que passaram a se chamar "Negócio", e o
passo das colunas de `contatos`, que agora mostra o selo de classificação.

## Recapturar

Todos os módulos da tabela, nos dois idiomas. Os de cards do funil (`funis`,
`etapas-do-funil`, `inbox`) mudaram de seletor, então nenhuma foto antiga deles vale.

## Pontos que só a captura prova

Os seletores foram lidos dos componentes. Estes são os que podem falhar primeiro:

1. **Menus e listas Radix** abertos com `click` (submenu "Passar para vendedor",
   seletores do diálogo "Registrar interação", da transferência e de Vínculos).
2. **Swagger** (`documentacao-da-api`): `.auth-wrapper > button.btn.authorize`, a
   janela `.modal-ux` e o id `#operations-Contatos-listarContatos`, que supõe a regra
   `operations-<tag>-<operationId>` do swagger-ui 5.34.1.
3. **Seletor de empresas da Visão consolidada**: o popover fecha ao recarregar, por
   isso os passos o reabrem.
4. **Linhas de Conversas e Contatos do consolidado**: `ul.divide-y > li:first-child`,
   sem testid; a primeira linha pode ser de qualquer empresa.
5. **Histórico de atendimento**: a conversa de "hoje" some entre 0h e 2h10 (horário de
   São Paulo).
6. **Salvar em Vínculos** fica perto do rodapé a 900 px, e o POST exige MFA e escopo
   `full` do admin da plataforma.
7. **Trunk SIP**: sem worker de voz na bancada, o quadro "No servidor" fica em
   "Aguardando o servidor aplicar"; os outros resultados são explicados só em texto.
8. **Buscar atualização**: o botão só é destacado, nunca clicado, porque o clique chama
   o GitHub de verdade.

## Verificado sem bancada

- `curso/licoes.test.ts`, `curso/espanhol-alvos.test.ts` e
  `curso/espanhol-demonstracao.test.ts`: 149 casos verdes.
- Toda frase literal passada a `demo()` nas sementes novas tem espanhol no catálogo.
- Typecheck e lint das sementes.
