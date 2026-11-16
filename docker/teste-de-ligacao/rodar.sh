#!/usr/bin/env bash
# TESTE DE LIGAÇÃO — uma ligação SIP de verdade atravessando o produto.
#
#   bash docker/teste-de-ligacao/rodar.sh
#
# Roda no CI (.github/workflows/telefonia.yml) e em qualquer máquina com Docker,
# sipp e um Supabase local já de pé com o baseline aplicado. Precisa no ambiente:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
#   SUPABASE_DB_URL (default: o Postgres do `supabase start`)
#
# O que sobe: o Asterisk do produto (mesma imagem e o MESMO extensions.conf e
# sorcery.conf do repositório), o worker de voz do repositório e uma sessão de
# voz falsa no lugar da OpenAI. A "operadora" é o sipp.
#
# Dois casos, medidos no BANCO (não no log):
#   1. agente de voz ativo: a IA atende, fala, pede para encerrar; a ligação fica
#      `ended`/`user_ended` com transcrição, o uso vai para `llm_calls` COM custo,
#      e o fim vira `voice_call.ended` nascido `done`;
#   2. sem agente de voz: a ligação encerra `no_agent` e abre o aviso
#      `voice_call_missed` na Central.
#
# O que NÃO mede: operadora real, NAT, registro, áudio de ida e volta audível.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
AQUI="$RAIZ/docker/teste-de-ligacao"
TRABALHO="$(mktemp -d)"
DB="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
ASTERISK_IMAGE="${ASTERISK_IMAGE:-$(sed -nE 's/.*image: \$\{ASTERISK_IMAGE:-([^}]+)\}.*/\1/p' "$RAIZ/docker-compose.prod.yml" | head -1)}"
CONTEINER="teste-de-ligacao-asterisk"

ORG="0f0f0f0f-0000-4000-8000-000000000001"
AGENTE="0f0f0f0f-0000-4000-8000-000000000002"
NUMERO="5527000000001"

PIDS=()
encerrar() {
  local codigo=$?
  if [ "$codigo" -ne 0 ]; then
    echo "::group::log do worker de voz"; cat "$TRABALHO/voice-agent.log" 2>/dev/null || true; echo "::endgroup::"
    echo "::group::log do Asterisk"; docker logs "$CONTEINER" 2>&1 | tail -n 200 || true; echo "::endgroup::"
    echo "::group::sessões de voz falsas"; cat "$TRABALHO/sessoes.jsonl" 2>/dev/null || true; echo "::endgroup::"
  fi
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  docker rm -f "$CONTEINER" >/dev/null 2>&1 || true
  rm -rf "$TRABALHO"
  exit "$codigo"
}
trap encerrar EXIT

q() { psql "$DB" -v ON_ERROR_STOP=1 -At -c "$1"; }
esperar() {  # esperar <segundos> <descrição> <comando...>
  local limite=$1 oque=$2; shift 2
  for _ in $(seq 1 "$limite"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "::error::$oque não aconteceu em ${limite}s"; return 1
}
igual() {  # igual <descrição> <obtido> <esperado>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "::error::$1 — esperado '$3', veio '$2'"; return 1; fi
}

echo "==> semeando a empresa, o agente de voz e o número"
psql "$DB" -v ON_ERROR_STOP=1 -q <<SQL
insert into public.organizations (id, slug, legal_name, display_name)
values ('$ORG', 'teste-de-ligacao', 'Teste de Ligação Ltda', 'Teste de Ligação')
on conflict (id) do nothing;
insert into public.ai_agents (id, organization_id, name, system_prompt, channel, is_active)
values ('$AGENTE', '$ORG', 'Agente de voz do teste', 'Você é o atendimento de teste.', 'voice', true)
on conflict (id) do update set is_active = true;
insert into public.phone_numbers (organization_id, number, trunk_endpoint, routing_mode, default_ai_agent_id)
values ('$ORG', '$NUMERO', 'PJSIP/sipp', 'ai', '$AGENTE')
on conflict (number) do nothing;
SQL

echo "==> sessão de voz falsa"
( cd "$TRABALHO" && node "$AQUI/sessao-de-voz-falsa.mjs" 8099 >"$TRABALHO/sessao.log" 2>&1 ) &
PIDS+=($!)

echo "==> Asterisk ($ASTERISK_IMAGE)"
docker run -d --name "$CONTEINER" --network host --add-host voice-agent:127.0.0.1 \
  -v "$AQUI/pjsip.conf:/etc/asterisk/pjsip.conf:ro" \
  -v "$AQUI/ari.conf:/etc/asterisk/ari.conf:ro" \
  -v "$RAIZ/asterisk/extensions.conf:/etc/asterisk/extensions.conf:ro" \
  -v "$RAIZ/asterisk/sorcery.conf:/etc/asterisk/sorcery.conf:ro" \
  -v "$RAIZ/asterisk/http.conf:/etc/asterisk/http.conf:ro" \
  -v "$RAIZ/asterisk/rtp.conf:/etc/asterisk/rtp.conf:ro" \
  "$ASTERISK_IMAGE" >/dev/null
esperar 60 "a ARI responder" curl -sf -u voice-agent-user:teste-de-ligacao http://127.0.0.1:8088/ari/asterisk/info

echo "==> worker de voz"
(
  cd "$RAIZ"
  NODE_ENV=development \
  ARI_URL=http://127.0.0.1:8088 ARI_WS_URL=ws://127.0.0.1:8088/ari/events \
  ARI_USERNAME=voice-agent-user ARI_PASSWORD=teste-de-ligacao ARI_APP=voice-agent \
  OPENAI_API_KEY=sk-teste-de-ligacao OPENAI_REALTIME_URL=ws://127.0.0.1:8099 \
  OPENAI_REALTIME_MODEL=gpt-realtime AUDIOSOCKET_PORT=9092 \
  SUPABASE_DB_URL="$DB" AI_CRED_AES_KEY="$(openssl rand -base64 32)" \
  pnpm exec tsx workers/voice-agent/index.ts >"$TRABALHO/voice-agent.log" 2>&1
) &
PIDS+=($!)
# A Stasis app só existe enquanto o worker está conectado à ARI.
esperar 60 "o worker registrar a Stasis app" curl -sf -u voice-agent-user:teste-de-ligacao http://127.0.0.1:8088/ari/applications/voice-agent

ligar() {
  sipp -sf "$AQUI/ligacao.xml" -s "$NUMERO" 127.0.0.1:5060 -p 5070 -mp 6000 -m 1 \
    -timeout 45 -timeout_error -nostdin -trace_err -error_file "$TRABALHO/sipp-erros.log" >/dev/null
}

echo "==> caso 1: a IA atende e desliga"
ligar
esperar 15 "a ligação encerrar no banco" bash -c \
  "[ \"\$(psql '$DB' -At -c \"select count(*) from public.voice_calls where organization_id='$ORG' and status='ended'\")\" = 1 ]"
igual "a ligação encerrou como fim normal" \
  "$(q "select end_reason from public.voice_calls where organization_id='$ORG' order by started_at limit 1")" "user_ended"
igual "foi atendida" \
  "$(q "select (answered_at is not null)::text from public.voice_calls where organization_id='$ORG' order by started_at limit 1")" "true"
igual "a fala da IA está na transcrição" \
  "$(q "select (transcript::text like '%atendimento de teste%')::text from public.voice_calls where organization_id='$ORG' order by started_at limit 1")" "true"
igual "o uso foi para llm_calls com custo" \
  "$(q "select count(*) from public.llm_calls where organization_id='$ORG' and purpose='voz_ao_vivo' and cost_cents > 0")" "1"
igual "o fim virou voice_call.ended nascido done" \
  "$(q "select count(*) from public.event_log where organization_id='$ORG' and event_type='voice_call.ended' and status='done'")" "1"
igual "a sessão abriu com as instruções do agente" \
  "$(grep -c 'Você é o atendimento de teste' "$TRABALHO/sessoes.jsonl")" "1"

echo "==> caso 2: sem agente de voz ativo"
q "update public.ai_agents set is_active = false where id = '$AGENTE'" >/dev/null
ligar
esperar 15 "a segunda ligação encerrar no banco" bash -c \
  "[ \"\$(psql '$DB' -At -c \"select count(*) from public.voice_calls where organization_id='$ORG' and status='ended'\")\" = 2 ]"
igual "encerrou como sem agente" \
  "$(q "select end_reason from public.voice_calls where organization_id='$ORG' order by started_at desc limit 1")" "no_agent"
igual "abriu o aviso de ligar de volta" \
  "$(q "select count(*) from public.agent_inbox_items where organization_id='$ORG' and kind='voice_call_missed'")" "1"

echo "✓ teste de ligação passou"
