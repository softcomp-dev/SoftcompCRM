#!/usr/bin/env bash
# Prova de `recriar_a_telefonia` (_common.sh), chamada pelo update.sh.
#
#   bash tests/shell/telefonia-rele-o-dialplan.test.sh
#
# Os arquivos de `asterisk/` entram no contêiner por bind mount de um arquivo,
# preso ao inode: sem recriar, o Asterisk de quem atualiza segue com o
# `extensions.conf` antigo — e o dialplan é contrato com o worker de voz (a
# passagem da IA para o time só existe a partir do dialplan novo). Três casos:
#
#  1. com `telefonia` em COMPOSE_PROFILES, recria `asterisk` E `voice-agent`
#     (a conexão ARI do worker cai junto com o Asterisk);
#  2. sem o profile, não chama o docker — nomear o serviço ATIVARIA o profile e
#     subiria a telefonia em quem nunca a ligou;
#  3. o profile no meio de uma lista (`voz,telefonia`) também conta.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# shellcheck disable=SC1091
source "$ROOT/hostgator-setup-kit/_common.sh" >/dev/null 2>&1 || true
set +e

# Dublê: `dc` só registra o que lhe pediram.
dc() { printf '%s\n' "$*" >>"$WORK/dc.log"; return 0; }
dc_files() { printf -- '-f docker-compose.prod.yml'; }

rodar() {  # rodar <COMPOSE_PROFILES>
  : >"$WORK/dc.log"
  printf 'DOMAIN=crm.exemplo\nCOMPOSE_PROFILES=%s\n' "$1" >"$WORK/.env"
  recriar_a_telefonia "$WORK/.env" >/dev/null 2>&1
}

echo "telefonia relê o dialplan na atualização"

rodar "telefonia"
check "com telefonia: recria asterisk e voice-agent" \
  grep -qx "up -d --force-recreate --no-deps asterisk voice-agent" "$WORK/dc.log"

rodar ""
check "sem o profile: o docker nem é chamado" test ! -s "$WORK/dc.log"

rodar "voz"
check "com outro profile só: o docker nem é chamado" test ! -s "$WORK/dc.log"

rodar "voz,telefonia"
check "telefonia no meio da lista também conta" \
  grep -qx "up -d --force-recreate --no-deps asterisk voice-agent" "$WORK/dc.log"

check "o update.sh chama a função" grep -q "recriar_a_telefonia .env" "$ROOT/hostgator-setup-kit/update.sh"

if [ "$FAILS" -gt 0 ]; then
  echo "✗ $FAILS caso(s) falharam"
  exit 1
fi
echo "✓ todos os casos passaram"
