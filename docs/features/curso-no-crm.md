# Curso dentro do CRM

**Onde:** Configurações › Ajuda › **Curso** (`/app/curso`), o atalho "Aprender pelo
curso" no topo da Ajuda e a busca ⌘K.

A tela abre o curso ilustrado (aulas com a foto de cada tela, setas, caixas e o
simulador) num quadro, no idioma da interface: espanhol para quem usa o CRM em
espanhol, português para o resto. O link "Abrir em nova aba" abre a mesma página fora
do CRM.

## Por que o curso mora fora da imagem

As fotos dos dois idiomas passam de 100 MB. Na imagem do app, cada recaptura engordaria
a imagem que todo servidor baixa; no git, engordaria todo clone. Por isso:

- o curso montado vira o anexo `curso.tar.gz` de uma Release `curso-AAAA-MM-DD`;
- o workflow [`publicar-curso.yml`](../../.github/workflows/publicar-curso.yml) baixa o
  anexo e o publica no GitHub Pages do fork;
- a instalação diz onde o curso está pela variável `CURSO_URL`
  ([`lib/env.ts`](../../lib/env.ts)). Vazia, a aba diz que o curso não está disponível.

O endereço não tem padrão no código: o host de quem publica não pode viajar na imagem que
todo cliente instala (catraca de host de terceiro em `tests/unit/branding.test.ts`). No
servidor do fork, o `.env` declara `CURSO_URL=https://softcomp-dev.github.io/SoftcompCRM/`.

## Publicar uma versão nova do curso

1. **Fotografar** na bancada, nos dois idiomas
   ([`docs/runbooks/atualizar-curso.md`](../runbooks/atualizar-curso.md)).
2. **Empacotar** na bancada:

   ```bash
   bash curso/empacotar-publicacao.sh /SoftcompCRM/ /tmp/curso.tar.gz
   ```

   O script monta o português (`/SoftcompCRM/`) e o espanhol (`/SoftcompCRM/es/`) e
   recusa o pacote se ele levar algo que não é do site: `contas.json` (as senhas das
   contas de demonstração), manifesto ou foto de falha.
3. **Criar a Release, sempre como não-latest:**

   ```bash
   gh release create curso-AAAA-MM-DD curso.tar.gz --latest=false \
     --title "Curso AAAA-MM-DD" --notes "Curso ilustrado montado na bancada."
   ```

   ⚠️ O "Atualizar" do servidor procura a Release mais recente. Uma Release de curso
   marcada como latest seria oferecida como versão do app. A tag `curso-*` também não
   casa com o `v*` que o `agent.sh` lê.
4. O workflow publica sozinho. Para republicar uma Release que já existe:
   `gh workflow run publicar-curso.yml -f tag=curso-AAAA-MM-DD`.

## Onde mora cada peça

| Peça | Artefato |
|---|---|
| Tela | `app/app/curso/` |
| Endereço por idioma (puro) | `lib/curso/endereco.ts` |
| Variável | `CURSO_URL` em `lib/env.ts` e `.env.example` |
| Menu | `lib/navigation/catalogo.ts` (seção Ajuda), atalho em `lib/ajuda/hub.ts` |
| Empacotamento | `curso/empacotar-publicacao.sh` |
| Publicação | `.github/workflows/publicar-curso.yml` |

## Laço de retorno

- Endereço errado ou vazio: a tela diz que o curso não está disponível, e o log avisa
  quando o valor não é http(s).
- Pacote incompleto: o workflow recusa publicar sem os dois idiomas.
- Curso desatualizado: o roteiro de captura em
  [`evidence/curso-funcionalidades-do-fork/`](../../evidence/curso-funcionalidades-do-fork/README.md)
  diz o que recapturar.
