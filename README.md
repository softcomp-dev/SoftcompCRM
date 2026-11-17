<div align="center">

# SoftcompCRM

**CRM com agentes de IA para atendimento e vendas pelo WhatsApp, rodando no seu próprio servidor.**

Os agentes atendem, qualificam e movem o funil junto com a sua equipe. Os dados ficam na sua VPS.

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-1%20comando-orange)](hostgator-setup-kit/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**Instalar**](#instalar-na-sua-vps) · [**Atualizar**](#atualizar) · [**O que é**](#o-que-é) · [**Desenvolvimento**](#desenvolvimento) · [**Suporte**](#suporte-e-responsabilidades)

</div>

---

## Instalar na sua VPS

### 1. Entre na VPS

Abra o terminal no seu computador (PowerShell no Windows, Terminal no Mac ou Linux) e conecte
com o IP e a porta que a hospedagem enviou:

```bash
ssh -p PORTA root@SEU_IP
```

Se a hospedagem não informou porta, é a padrão (22): `ssh root@SEU_IP`.

Ao digitar a senha, nada aparece na tela, nem asteriscos. Digite (ou cole) e pressione Enter.
Na primeira conexão, responda `yes` à pergunta `Are you sure you want to continue connecting?`.

### 2. Rode o instalador

Dentro da VPS:

```bash
git clone https://github.com/softcomp-dev/SoftcompCRM.git
cd SoftcompCRM
bash hostgator-setup-kit/install.sh
```

Não é preciso instalar Node, pnpm nem compilar nada: as imagens do app já vêm prontas, publicadas
em `ghcr.io/softcomp-dev`. Se faltar Docker, o instalador pergunta e instala.

Ainda não escolheu o servidor? No seu computador (macOS, Linux ou WSL), este comando indica o
plano adequado e devolve o comando de instalação certo para o seu caso:

```bash
curl -fsSL https://raw.githubusercontent.com/softcomp-dev/SoftcompCRM/main/hostgator-setup-kit/comecar.sh | bash
```

### O que ter em mãos

| Item | Onde conseguir |
|---|---|
| **VPS com Docker** | Qualquer VPS com Docker. 4 GB de RAM recomendados |
| **Domínio** | Um registro **A** apontando para o IP da VPS (ex.: `crm.suaempresa.com.br`) |
| **Banco** | Conta no [supabase.com](https://supabase.com): 3 chaves e a connection string do **Session pooler**. Se o projeto cair parado (`522` ou `PGRST002` por horas), o compute Nano do plano grátis pode não bastar: [veja o runbook](docs/runbooks/custo-e-cota-do-supabase.md#5-quando-o-compute-nano-do-plano-grátis-não-basta) |
| **IA** | Uma chave de **OpenRouter**, **Anthropic** ou **OpenAI**; o instalador pergunta qual |
| **WhatsApp** | O número da empresa, conectado por QR code no onboarding (ou o canal oficial da Meta) |

O instalador também funciona em VPS ARM64/aarch64 (ex.: Oracle Ampere A1) e escolhe a imagem do
WhatsApp compatível com a arquitetura.

> O Supabase pode ser criado pelo próprio instalador: exporte um `SUPABASE_ACCESS_TOKEN` antes de
> rodar e ele cria o projeto, espera o banco ficar saudável e busca as credenciais sozinho.

### O que o instalador faz

Ele pergunta só o que é seu (domínio, chaves, senha do admin), valida cada resposta antes de
seguir e cuida do resto:

1. Gera os segredos técnicos.
2. Cria as extensões do Postgres e aplica o schema completo (`supabase/baseline.sql`).
3. Cria o primeiro admin com o e-mail e a senha escolhidos.
4. Sobe a stack com **HTTPS automático** e confere a saúde no fim.
5. Instala o **cron das automações** e o **agente de atualização**, que habilita o botão
   "Atualizar agora" na tela.

Rodar de novo não quebra nada: o `install.sh` é idempotente e retoma de onde parou.

> **Modo não interativo:** copie `.env.hostgator.example` para `.env`, preencha e rode
> `bash hostgator-setup-kit/install.sh --yes`.

### VPS com proxy próprio (Hostinger, Coolify, Dokploy, CapRover…)

Se a VPS já tem um proxy reverso ocupando as portas 80/443, o instalador detecta e publica o CRM
através dele. Quando o proxy roda em `--network host` (caso da Hostinger), ele pergunta em vez de
adivinhar. Detalhes em [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md#vps-que-já-vem-com-proxy-próprio-hostinger-coolify-dokploy).

### Primeiro acesso

Abra `https://<seu-domínio>` (o certificado leva cerca de 1 minuto), entre com o admin e, no
onboarding, escaneie o QR code com o WhatsApp do número da empresa. A verificação em duas etapas
é opcional e fica em **Configurações › Segurança**.

---

## Atualizar

### Pela tela (recomendado)

Quando há versão nova, o rodapé do menu lateral mostra **"Nova versão"** para o dono do
servidor. O clique leva a **Configurações → Atualização**, que mostra o que muda, faz backup do
banco e acompanha cada fase (backup → código → banco → no ar).

Se a versão nova subir quebrada, o agente volta para a imagem anterior sozinho.

> O app só registra o pedido; quem executa é o agente instalado na VPS, num cron que confere a
> cada 5 minutos. Se o agente estiver fora do ar, a tela avisa e mostra o comando abaixo.

### Pelo terminal

```bash
cd /caminho/do/SoftcompCRM
bash hostgator-setup-kit/update.sh
```

O comando confere se há versão nova, **faz backup do banco**, baixa o código, atualiza o banco
re-aplicando o `baseline.sql` (idempotente e auto-curativo), puxa as imagens novas e confere a
saúde no fim.

O alvo é sempre a última versão publicada (`v1.2.3`), descrita no [`CHANGELOG.md`](CHANGELOG.md).
Cada push com código na `main` deste repositório gera uma versão nova e publica as imagens
automaticamente.

Na parte do banco, mensagens como `already exists` são esperadas e inofensivas; o script filtra
esse ruído e mostra `✓ banco atualizado`. Se aparecer `⚠ Apareceram avisos no banco que NÃO são
os esperados`, o fim da saída diz o que fazer.

Passo a passo em linguagem simples: [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md).

### Comandos do kit

| Script | Função |
|---|---|
| `install.sh` | Instala tudo (idempotente) |
| `update.sh` | Atualiza para a versão nova, com backup automático |
| `backup.sh` | Backup do banco e das sessões de WhatsApp |
| `restore.sh` | Restaura um backup (num banco vazio) |
| `reset-password.sh` | Redefine a senha de um usuário |
| `reset-mfa.sh` | Remove o MFA de quem perdeu o celular |
| `healthcheck.sh` | Diagnóstico dos serviços; sai 1 quando o app não está saudável |

> O plano grátis do Supabase **não faz backup sozinho**. Agende o `backup.sh` no cron
> diariamente; o `update.sh` já faz um backup antes de cada atualização.

### Desinstalar

Para parar e apagar **somente os recursos Docker desta instalação**, na raiz do repositório:

```bash
bash desinstalar_docker.sh
```

Remove apenas containers, volumes e redes internas deste projeto, depois de pedir a confirmação
`REMOVER-<nome-do-projeto>`. Código, `.env`, backups e outras aplicações do servidor não são
tocados. **Os volumes vão junto**, inclusive as sessões locais do WhatsApp: rode `backup.sh` antes
se precisar preservá-las.

---

## O que é

O SoftcompCRM é um sistema de vendas e atendimento para qualquer negócio que vende pelo WhatsApp:
lojas, clínicas, imobiliárias, prestadores de serviço. Agentes de IA com base de conhecimento por
empresa atendem, qualificam, movem leads no funil, disparam automações e passam a conversa para um
humano na hora certa.

### Recursos

- **Agentes de IA que operam o CRM**: base de conhecimento (RAG) por empresa, skills executadas
  durante o atendimento, memória da operação, análise de sentimento, passagem IA → humano
  auditada e teto de gasto por organização.
- **Follow-up**: retoma conversas que esfriaram, com gatilhos por etapa do funil, e um radar do
  que está sem resposta.
- **Funil configurável por negócio**: lead pode virar *Cliente*, *Paciente* ou *Comprador*; ganho
  pode virar *Pago*, *Agendado* ou *Fechado*. Integração com Nuvemshop.
- **WhatsApp de duas formas**: por QR code (multi-número, com proteção contra banimento: ritmo de
  envio e janela de horário) ou pelo canal oficial da Meta (Cloud API, com templates).
- **Escolha do provedor de IA**: OpenRouter, Anthropic ou OpenAI, trocável depois pela tela.
- **Governança de atendimento**: papéis com permissão no servidor, atribuição e transferência
  auditadas, fila com rodízio e roteamento automático por intenção.
- **Multiempresa e LGPD**: isolamento por organização no banco (RLS), anonimização de dados
  pessoais e log de auditoria somente inclusão.
- **Marca própria**: nome, logo e cor configuráveis por instalação e por organização.

### Webhooks e automações

Cada organização pode criar **fontes de captação**: um endereço público
(`/api/v1/webhooks/in/<token>`) que recebe leads de landing pages, formulários ou ferramentas como
Zapier/n8n e os coloca direto no funil. Sobre essas fontes e os eventos do CRM (lead mudou de
etapa, ganhou tag, chegou mensagem), montam-se **automações** QUANDO/SE/ENTÃO: adicionar tag, mover
o lead, atribuir a um atendente, enviar WhatsApp ou chamar outro sistema.

Tudo fica em **Webhooks** no menu lateral (papéis `manager` e `admin`). Quem executa as automações
é o cron `/api/v1/cron/event-log-drain`, que o `install.sh` e o `update.sh` já configuram.

### Telas

| Grupo | Telas |
|---|---|
| **Atendimento** | Inbox · Radar · Respostas rápidas |
| **CRM** | Kanban · Contatos · Funis |
| **Agente de IA** | Agentes · Follow-ups · Roteadores · Provedores e Credenciais · Conhecimento · Memória · Skills · Casos · Alertas · Propostas · Execuções · Uso e orçamento |
| **Canais** | Conexões · Nuvemshop · Webhooks |
| **Análise** | Desempenho · Evolução da IA · Audit Log |
| **Organização** | Equipe · Distribuição de atendimento · Organização · LGPD · API Tokens · Segurança · Perfil, Notificações, Billing |

---

## Stack

| Camada | Escolha |
|---|---|
| **Frontend** | Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito |
| **Estilo** | Tailwind 4 + shadcn/ui |
| **Banco** | Supabase (Postgres + RLS + `vector`) |
| **Auth** | Supabase Auth via `@supabase/ssr` |
| **Realtime / Storage** | Supabase Realtime e Storage (URLs assinadas) |
| **WhatsApp** | WAHA (engine NOWEB) + Meta Cloud API |
| **Filas** | Tabela `event_log` + workers (cron) |
| **Rate limit** | Redis (sliding window) |
| **IA** | Vercel AI SDK: OpenRouter, Requesty, Anthropic, OpenAI e Google |
| **Validação** | Zod |
| **Observabilidade** | Sentry, com dados pessoais removidos |
| **Hospedagem** | VPS com Docker |

Detalhes em [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Desenvolvimento

> Para **usar** o CRM, siga o [instalador da VPS](#instalar-na-sua-vps). Esta seção é para quem
> vai mexer no código.

```bash
git clone https://github.com/softcomp-dev/SoftcompCRM.git
cd SoftcompCRM

nvm use                     # Node 22
npm install -g pnpm && pnpm install

cp .env.example .env.local  # guia completo em docs/SETUP.md

docker compose up -d        # WAHA local (opcional sem WhatsApp)

# Schema: aplique o baseline, NÃO as migrations (a cadeia não sobe do zero).
# Num projeto Supabase novo, habilite antes as extensões:
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

[`docs/SETUP.md`](docs/SETUP.md) traz o passo a passo de todas as integrações (Supabase, WAHA,
provedores de IA, Redis, Sentry, Resend, Nuvemshop).

### Estrutura

```
SoftcompCRM/
├── app/                    # Next.js App Router (telas e API REST em app/api/v1/)
├── components/             # componentes React
├── lib/                    # supabase/, waha/, channels/, ai/, api/, routing/, env.ts
├── workers/                # consumidores do event_log (IA, RAG, LGPD, mídia)
├── supabase/migrations/    # SQL versionado (+ baseline.sql para instalação)
├── tests/{e2e,unit,invariants,shell}/
├── scripts/                # seeds e manutenção
├── docs/                   # specs, runbooks, SETUP.md, ATUALIZANDO.md
└── hostgator-setup-kit/    # instalação e atualização na VPS
```

### Testes

```bash
pnpm typecheck     # tsc --noEmit (inclui tests/)
pnpm lint          # eslint
pnpm test:unit     # Vitest (não inclui tests/invariants/**)
pnpm test:db       # Postgres efêmero + baseline install/update + invariantes (precisa de Docker)
pnpm test:e2e      # Playwright (precisa do dev server)
```

Mudança de schema sai como migration versionada em `supabase/migrations/` **e** como apêndice
idempotente no `supabase/baseline.sql`, senão não chega às instalações existentes. As convenções
completas estão em [`CLAUDE.md`](CLAUDE.md).

### Documentação

| Doc | Conteúdo |
|---|---|
| [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md) | Instalação: o kit, os scripts e hospedagens com proxy próprio |
| [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md) | Como atualizar uma instalação |
| [`CHANGELOG.md`](CHANGELOG.md) | O que mudou em cada versão |
| [`docs/SETUP.md`](docs/SETUP.md) | Setup de desenvolvimento |
| [`docs/white-label.md`](docs/white-label.md) | Marca própria e instalação para clientes |
| [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md) | Deploy em produção |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Arquitetura em uma página |
| [`docs/index.md`](docs/index.md) | Índice geral da documentação |

---

## Reportando bugs

Abra uma [issue](https://github.com/softcomp-dev/SoftcompCRM/issues) com o ambiente, a saída de
`/api/v1/health` e os passos para reproduzir. Colar a saída de
`bash hostgator-setup-kit/healthcheck.sh` ajuda bastante.

Vulnerabilidades de segurança **não** devem ir em issue pública: use o
[relato privado](https://github.com/softcomp-dev/SoftcompCRM/security/advisories/new). Detalhes em
[`SECURITY.md`](SECURITY.md).

---

## Suporte e responsabilidades

Cada instalação roda na infraestrutura de quem a hospeda (VPS, banco Supabase e chave de IA
próprios):

- **Quem hospeda é responsável pela instalação**: atualizações (pelo botão ou pelo `update.sh`),
  backup e manutenção do servidor.
- **LGPD**: quem hospeda a instância é o **controlador** dos dados pessoais ali tratados
  (clientes, conversas, pedidos), com as obrigações legais decorrentes.
- **Telemetria (Sentry)**: o `install.sh` pergunta durante a instalação; em modo não interativo,
  sem `SENTRY_DSN`, ela fica desligada. Os relatórios de erro saem com CPF, telefone e e-mail
  substituídos e cabeçalhos sensíveis removidos ([`lib/sentry/scrub.ts`](lib/sentry/scrub.ts)).
  Para desligar: `SENTRY_DSN=off` no `.env`. Para usar o seu Sentry: `SENTRY_DSN=<seu-dsn>`.

---

## Licença

Distribuído sob a licença **MIT**; veja [`LICENSE`](LICENSE). O software é fornecido "como está",
sem garantias.

<div align="center">

**Softcomp** · [github.com/softcomp-dev](https://github.com/softcomp-dev)

</div>
