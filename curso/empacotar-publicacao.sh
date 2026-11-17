#!/usr/bin/env bash
# Monta o curso em português e empacota o que o GitHub Pages serve.
#
#   bash curso/empacotar-publicacao.sh /SoftcompCRM/ /caminho/curso.tar.gz
#
# O primeiro argumento é o caminho em que o site vai morar (o CURSO_BASE). Roda
# onde as fotos estão — a bancada de captura —, com `curso/saida` completo.
#
# Só português, por decisão do dono do fork (17/11/2026). O espanhol continua
# possível: é outra rodada de captura em `curso/saida/es` e um segundo
# `montar.ts` com a base `<base>es/`.
#
# O pacote leva só o que a página precisa: index.html e capturas/. Fica de fora
# o que não pode sair da bancada: `contas.json` (as senhas das contas de
# demonstração), os manifestos e as fotos de falha.
#
# O curso é publicado FORA da imagem e do git: o pacote vira anexo de uma
# Release `curso-AAAA-MM-DD` (não-latest) e o workflow publicar-curso.yml o
# entrega ao GitHub Pages. Ver docs/features/curso-no-crm.md.
set -euo pipefail

base="${1:?uso: empacotar-publicacao.sh <base, ex.: /SoftcompCRM/> <saida.tar.gz>}"
pacote="${2:?uso: empacotar-publicacao.sh <base> <saida.tar.gz>}"
case "$base" in /*/) ;; *) echo "a base precisa começar e terminar com / (veio \"$base\")" >&2; exit 2 ;; esac

cd "$(dirname "$0")/.."

CURSO_IDIOMA=pt-BR CURSO_SAIDA=curso/saida CURSO_BASE="$base" pnpm exec tsx curso/montar.ts

site="$(mktemp -d)"
trap 'rm -rf "$site"' EXIT
cp curso/saida/index.html "$site/"
cp -r curso/saida/capturas "$site/"

# Nada de conta, manifesto ou foto de falha pode ter entrado.
if find "$site" -name '*.json' -o -name 'falha-*' | grep -q .; then
  echo "o pacote levaria arquivo que não é do site — recusado" >&2
  exit 1
fi

tar -czf "$pacote" -C "$site" .
echo "pacote: $pacote ($(du -h "$pacote" | cut -f1)) — curso em ${base}"
