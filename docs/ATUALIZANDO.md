# Atualizando o DeskcommCRM na sua VPS

Saiu uma versão nova? Atualizar é **um comando só**. Você não precisa saber se a
novidade é no código, no banco de dados ou nos dois — o comando cuida de tudo, na
ordem certa e com backup automático antes de mexer em qualquer coisa.

## O que fazer

Entre no seu servidor (o mesmo acesso SSH que você usou pra instalar), vá até a pasta
do projeto e rode:

```bash
bash hostgator-setup-kit/update.sh
```

Pronto. Pode deixar rodando — leva alguns minutos. No fim, você vê **`✓ Atualização
concluída — app no ar e saudável`**. Se ele disser que você **já está na versão mais
recente**, é porque não havia nada novo pra baixar; está tudo certo.

## Pela tela, sem SSH

Quem administra o servidor também atualiza pelo próprio CRM, em **Configurações ›
Atualização** (`/app/settings/atualizacao`):

- **Buscar atualização** pergunta ao GitHub, na hora, qual é a última versão publicada
  e diz se já saiu uma nova, se você já está na mais recente ou por que não deu para
  saber. Sem o botão, a conferência automática continua rodando sozinha a cada 5 minutos.
- **Atualizar agora** aparece quando o servidor confirma que há versão nova (em até 5
  minutos depois da busca). O botão Buscar só traz a notícia: quem confirma a versão
  instalada e quem atualiza é o agente do servidor, com o mesmo backup do comando acima.
- **Voltar para a versão anterior** aparece quando uma atualização não deu certo. O
  sistema sai do ar por cerca de 2 minutos e volta para a versão de onde a tentativa
  saiu.

O botão **Buscar atualização** só aparece depois da primeira atualização feita com a
versão que o trouxe, porque é a partir dela que o servidor informa de onde vêm as
versões. Nada precisa ser configurado.

## O que o comando faz (por baixo)

1. Confere se há mesmo uma versão nova.
2. **Faz um backup do banco** — a rede de segurança, antes de tocar em qualquer coisa.
3. Baixa o código novo.
4. Atualiza o banco de dados (inclusive corrigindo sozinho conversas bagunçadas de
   versões antigas).
5. Baixa a versão nova do aplicativo e reinicia.
6. Confere se o CRM voltou no ar.

## Coisas normais que você pode ver (não se assuste)

- **Um monte de linhas com "already exists" / "multiple primary keys"** durante a parte
  do banco: **é esperado e inofensivo** — são coisas que já existiam. O comando filtra
  esse ruído e, se estiver tudo certo, mostra **`✓ banco atualizado`**.
- Se o banco estiver ocupado com o CRM atendendo, o comando **aplica de novo sozinho** (até
  3 passadas) e mostra na tela o que precisou refazer. Isso é normal, e vale a partir da
  atualização seguinte à que instalar esta correção (quem executa a atualização é o
  instalador que já está no servidor).
- Se aparecer **`⚠ Apareceram avisos no banco que NÃO são os esperados`**, aí sim vale prestar
  atenção: o app provavelmente ainda funciona, mas guarde a mensagem. Quando o banco **NÃO
  termina limpo**, o **fim** da saída diz o que fazer, e a resposta depende da causa:
  - **banco ocupado ou fora de alcance:** repita a atualização num horário de pouco movimento,
    com o comando que a própria tela mostra
    (`bash hostgator-setup-kit/update.sh --to <versão> --force`);
  - **permissão** (`must be owner`, `permission denied`): repetir não resolve — a conexão do
    `.env` não é a dona do banco. Declare `SUPABASE_DB_ADMIN_URL` e repita;
  - **qualquer outra coisa:** guarde a mensagem e peça ajuda.
  O backup feito antes da atualização **não** volta por cima do banco em uso: o `restore.sh` só
  restaura num banco vazio (ver `hostgator-setup-kit/README.md`). Se precisar voltar o banco ao
  estado anterior, peça ajuda.

## Dicas

- **Quando rodar?** Sempre que avisarem que saiu versão nova. Rodar sem ter novidade não
  faz mal — o comando só diz "já está na última" e sai.
- **Automático (opcional):** dá pra agendar pra toda semana. Rode `crontab -e` e adicione
  (troque o caminho pela pasta do seu projeto):
  ```
  0 4 * * 0  cd /caminho/do/deskcommcrm && bash hostgator-setup-kit/update.sh
  ```
  Isso atualiza todo domingo às 4h da manhã, já com backup automático.
- **Deu algo estranho?** Rode `bash hostgator-setup-kit/healthcheck.sh` pra ver o estado
  de tudo de uma vez.
