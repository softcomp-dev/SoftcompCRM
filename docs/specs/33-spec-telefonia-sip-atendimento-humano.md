---
title: "Spec Técnica 33 — Telefonia SIP: a ligação chega a uma pessoa do time"
parent: 00-prd-master.md
type: spec
scope: telefonia SIP (Asterisk + workers/voice-agent), Telefonia, Central
status: fase A implementada; fase B pendente
version: 0.1.0
owner: arquitetura
created_at: 2026-11-16
related:
  - 18-spec-voice-calls-wacalls.md
  - 21-spec-conversa-pessoal-sai-da-operacao.md
---

# Spec Técnica 33 — Telefonia SIP: a ligação chega a uma pessoa do time

## 1. O problema

O número de voz (`phone_numbers`, migration 0347) sempre teve três modos de
atendimento (`routing_mode`): `ai`, `human` e `ai_then_human`. A tela deixava
escolher os três, mas o worker de voz (`workers/voice-agent`) ignorava a
escolha e mandava toda ligação para a IA. Sem agente de voz ativo, a ligação
caía em silêncio. Na ligação feita pelo CRM (`POST /api/v1/calls`), o
`mode: "human"` era aceito e a IA atendia mesmo assim.

## 2. Duas fases

O atendimento humano tem dois jeitos de existir, e os dois cabem no produto:

| | Fase A — encaminhar ao telefone do time | Fase B — telefone no navegador (WebRTC) |
|---|---|---|
| Como | O Asterisk disca para um celular ou fixo do time pelo mesmo tronco SIP, e junta as duas pernas numa ponte | Um ramal SIP por atendente; o navegador fala com o Asterisk por WebSocket seguro (WSS) com DTLS-SRTP |
| Onde se atende | No telefone, fora do CRM | Na ficha do contato, dentro do CRM |
| Custo para o cliente | Cada ligação encaminhada consome um segundo canal e minuto de saída do tronco | Nenhum custo extra de minuto |
| Estado | **Implementada** (novembro de 2026) | **Pendente — não implementada** |

### 2.1 Fase A — implementada

- **Cadastro.** O número ganhou `forward_to_phone` (o telefone do time) e
  `forward_ring_seconds` (10 a 60 s, padrão 25), migration 9255. A API e a tela
  de Telefonia recusam `human` ou `ai_then_human` sem telefone do time.
- **Modo `human`.** A perna de quem ligou fica na Stasis ouvindo o toque; o
  worker origina a perna do time para a app (`originarParaOTime`); quando o
  time atende, as duas entram numa ponte *mixing* e a linha vira `connected`.
  Ponte entre dois canais SIP funciona; o que não funcionava (medido ao vivo em
  28/08) era ponte com `externalMedia`. Código em
  `workers/voice-agent/encaminhar-ao-time.ts`.
- **Modo `ai_then_human`.** A IA atende. A ponte de voz oferece a ferramenta
  `passar_para_o_time` (só quando há telefone do time). Quando o modelo a chama,
  o worker marca `TRANSFERIR_PARA_TIME=1` no canal antes de fechar o
  AudioSocket; o dialplan (`asterisk/extensions.conf`,
  `[from-trunk-audiosocket]`) devolve o canal à Stasis com `transferir`, e o
  encaminhamento segue como no modo `human`. A linha fica `connected` e
  `handled_by = ai_then_human` durante a passagem.
- **Ninguém atende.** A linha encerra com `human_no_answer` e o aviso
  `voice_call_missed` ("Ligar de volta") nasce na Central — também quando a IA
  atendeu antes, porque quem ligou pediu uma pessoa e não falou com nenhuma.
  A operadora que recusa a discagem encerra com `human_unavailable`.
- **Quem já instalou.** O `update.sh` recria `asterisk` e `voice-agent` quando
  `telefonia` está em `COMPOSE_PROFILES` (`recriar_a_telefonia`): o dialplan
  entra por bind mount de um arquivo, e sem recriar o Asterisk seguiria com o
  arquivo antigo.

### 2.2 Fase B — PENDENTE

Nada da fase B existe no código. O que ela pede, para quem for fazer:

1. **Ramal por atendente.** Um endpoint PJSIP por usuário, criado pela ARI
   (configuração dinâmica, `sorcery` com astdb). O mecanismo já existe: é o
   mesmo que aplica o tronco salvo na tela (`asterisk/sorcery.conf`,
   `workers/voice-agent/aplicar-tronco.ts`) — o ramal é mais um objeto na
   mesma rodada.
2. **Transporte WebRTC no Asterisk.** `transport-wss`, `webrtc=yes` no
   endpoint do ramal, certificado (o do domínio, via Caddy) e DTLS-SRTP.
3. **Borda.** O Caddy encaminha `wss://<domínio>/sip` para o Asterisk (porta
   8089 interna). A mídia (SRTP/UDP) precisa de ICE; atrás de NAT ou CGNAT,
   provavelmente um TURN (coturn) — mais uma porta UDP e mais um serviço no
   compose, sob o profile `telefonia`.
4. **Navegador.** Um cliente SIP (JsSIP ou SIP.js) no painel de ligação que já
   existe para o WaCalls (`components/voice/ActiveCallPanel.tsx`).
5. **Os dois modos humanos ganham o destino "ramal no navegador"**, ao lado do
   telefone do time; e a **ligação feita com o atendente falando**
   (`POST /api/v1/calls`, `mode: "human"`) passa a existir: o sistema toca o
   ramal do atendente e, quando ele atende, disca para o cliente.

Até lá, `mode: "human"` na ligação feita responde 422
`voice_human_mode_unavailable`, e a tela de Telefonia diz que o modo humano
encaminha para o telefone do time.

## 3. Peças vizinhas que entraram junto

- **Tronco aplicado pela tela.** Salvar em Configurações › Trunk SIP basta: o
  worker de voz aplica o tronco pela ARI em até 30 s e grava o estado em
  `voip_trunk_status` (migration 9256), que a tela mostra. A ligação recebida
  diz o endpoint por onde chegou, e o tronco de DID único resolve por
  organização.
- **Custo da voz.** A ligação atendida pela IA entra em `llm_calls` com custo,
  pela tarifa de áudio de `lib/ai/tarifa-de-voz.ts`.
- **Reconexão.** O worker refaz a conexão de eventos com o Asterisk quando ela
  cai (`connectAriEvents`).
- **Teste de ligação no CI.** `.github/workflows/telefonia.yml` faz uma ligação
  SIP de verdade (sipp → Asterisk → worker → sessão de voz falsa) e mede o
  desfecho no banco. Cobre o atendimento pela IA e o "sem agente"; o
  encaminhamento ao time ainda não está nele (precisaria de um segundo sipp
  fazendo o papel do telefone do time).

## 4. O que não foi medido

- Nenhuma ligação com operadora real passou por este caminho: o ambiente onde a
  fase A foi escrita não tinha Asterisk, tronco nem Docker. Os testes
  (`fio-encaminhar-ao-time`, `fio-passar-ao-time`, `ponte-passa-ao-time`)
  dirigem o worker real contra um ARI gravador e uma tabela em memória. A prova
  numa VPS — ligar para o número, ouvir o time tocar, falar pela ponte, e a
  passagem da IA — fica por fazer.
- A aplicação do tronco pela ARI (configuração dinâmica + astdb) não rodou num
  Asterisk: em particular, se o registro na operadora começa sozinho quando o
  objeto `registration` é criado pela ARI. Se não começar, o estado na tela fica
  `offline` e o caminho é `pjsip send register <id>` no Asterisk.
- Se o provedor do tronco aceita o `callerId` de quem ligou na perna do time
  (alguns só aceitam o número próprio): sem isso o time vê o número da empresa.
