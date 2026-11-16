# Histórico de atendimento

**Onde:** CRM › Contatos › ficha do contato › aba **Atendimentos**.

A aba lista toda interação da equipe com o cliente, da mais recente para a mais antiga,
numa lista só. A regra de negócio é a
[AT-09](../business-rules/00-business-rules-catalog.md) do catálogo.

## O que aparece sozinho

- **Chat (WhatsApp):** as mensagens de **uma conversa num mesmo dia**, no fuso da
  organização, viram uma linha, com quantas mensagens vieram do cliente, da equipe, da
  IA e das automáticas, e um link para abrir a conversa. Reação, aviso do sistema e
  envio que falhou não contam. O dia é a unidade que quem vende usa ("falei com ele na
  terça"). Mensagem por mensagem seria a própria conversa, e a conversa inteira numa
  linha esconderia que o cliente voltou três vezes no mês.
- **Ligações** feitas pelo CRM, pelo VoIP ou pelo WhatsApp (`voice_calls`), com a
  duração. O desfecho é "Conversou" quando a ligação foi atendida e "Sem resposta"
  quando terminou sem atender.
- **Resultado do cold call** e as interações registradas pela equipe (abaixo).

**Nada é copiado.** Cada linha é lida da tabela de origem (`messages`, `voice_calls`,
`crm_lead_activities`) a cada consulta. Uma tabela "de atendimentos" seria a segunda
fonte da mesma história, e divergiria na primeira mensagem apagada pela LGPD.

A paginação termina sempre numa virada de dia, para o chat de um dia não aparecer
partido em duas páginas. Um dia com mais de 500 mensagens mostra a contagem só das 500
mais recentes daquela leitura.

## O que a equipe registra: "Registrar interação"

O que acontece fora do CRM entra pelo botão **Registrar interação**. O diálogo
(`components/atendimento/RegistrarInteracaoDialog.tsx`) pede:

| Campo | Opções |
|---|---|
| Negócio | um negócio **deste** contato (obrigatório) |
| Como foi | Ligação (celular ou fixo), WhatsApp pelo celular, E-mail, Reunião (presencial ou on-line), Visita, Outro |
| Quem procurou | A equipe procurou o cliente / O cliente procurou a equipe |
| Resultado | Falei com o cliente / Tentei, mas não consegui falar |
| Quando | data e hora (não pode estar no futuro) |
| Duração em minutos | opcional, até 24 h |
| O que foi conversado | texto livre, até 5.000 caracteres |

- **"Falei com o cliente"** grava `interaction_logged` e conta como movimento do
  negócio: atualiza `last_activity_at` do negócio e do contato (migration 9254), como
  uma ligação atendida pelo CRM.
- **"Tentei, mas não consegui falar"** grava `interaction_attempted`. Fica registrada,
  mas não conta como movimento (a mesma régua de `voice_call` / `voice_call_missed`).
- A interação aparece também na **linha do tempo do negócio**.
- **Papel:** `agent` ou acima registra; `viewer` só lê.

**Exceções:** contato sem negócio não registra interação, e a tela diz para criar o
negócio. Contato anonimizado responde 409. A interação registrada não se edita nem se
apaga pela tela, porque a RLS de `crm_lead_activities` só tem `select` e `insert`. Para
corrigir, registra-se outra.

## Onde mora cada peça

| Peça | Artefato |
|---|---|
| Junção das fontes (pura) | `lib/atendimento/historico.ts` (`agruparChats` e afins) |
| Registro manual (Zod, tipos) | `lib/atendimento/interacao-manual.ts` |
| API | `GET /api/v1/contacts/[id]/atendimentos` (`viewer`+); `POST` registra (`agent`+) |
| Tela | `components/atendimento/HistoricoDeAtendimento.tsx`, aba em `app/app/contacts/[id]/_client.tsx` |
| Dados | hook `hooks/atendimento/useHistoricoDeAtendimento.ts` |
| Banco | gatilho `fn_update_last_activity_at` (migration 9254, espelhada no `baseline.sql`) |
| Auditoria | `lead.updated` no negócio escolhido |

## Laço de retorno

- Contato sem negócio: a tela explica que é preciso criar o negócio antes de registrar.
- Registro errado: registra-se outro, e os dois ficam visíveis.
- "Falei com o cliente" quebra o silêncio do negócio, porque atualiza o último
  movimento (`last_activity_at`). A tentativa sem resposta não quebra, e o negócio
  continua parado para quem mede silêncio.
