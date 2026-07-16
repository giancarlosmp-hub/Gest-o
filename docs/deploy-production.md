# Deploy de produção

Este repositório possui um workflow seguro para atualizar a produção em `/apps/gest-o` após alterações entrarem na branch `main`.

## Diagnóstico do fluxo atual

- O preview é implantado pelo workflow `Preview Deploy`, acionado em eventos de `pull_request`, em diretórios isolados por PR no servidor.
- A produção deve acompanhar a branch `main` no diretório `/apps/gest-o` e servir o frontend em `crm.demetraagronegocios.com.br`.
- Quando a produção permanece em um build antigo depois do merge, o cenário mais provável é que o deploy de produção via GitHub Actions não tenha sido executado com sucesso, esteja sem secrets de SSH, ou o diretório `/apps/gest-o` esteja bloqueando o fast-forward por alterações locais.
- O script legado `deploy.sh` usa `git reset --hard origin/main`; ele deve ser evitado em automações sem uma janela operacional explícita porque pode sobrescrever alterações locais do servidor.

## Workflow

Arquivo: `.github/workflows/deploy-production.yml`.

Gatilhos:

- `push` na branch `main`, para deploy automático após merge.
- `workflow_dispatch`, para deploy manual. No acionamento manual, informe `production` no campo de confirmação.

Secrets aceitos pelo workflow:

- Preferenciais: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `SSH_PORT`.
- Compatibilidade com configuração existente: `VPS_HOST`, `VPS_USER`, `VPS_KEY`.
- Se `SSH_PORT` não existir, o workflow usa `22022`.

## Comandos executados no servidor

O workflow entra no diretório de produção, sincroniza a branch `main` apenas por fast-forward e executa o script versionado:

```bash
cd /apps/gest-o
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

O script `scripts/deploy-production.sh` executa, por padrão:

```bash
cd /apps/gest-o
git fetch origin main
git checkout main
git pull --ff-only origin main
docker compose build api web
docker compose up -d db
docker compose run --rm api npm run prisma:migrate:deploy -w @salesforce-pro/api
docker compose up -d api web
docker compose ps
```

## Segurança operacional

- Não há secrets versionados no repositório.
- O script não altera nem recria `.env`.
- O script não roda `git reset --hard`.
- O script aplica migrations pendentes com `prisma migrate deploy` antes de subir a API/Web novas; se a migration falhar, o deploy para pelo `set -e`.
- O script falha se houver alterações locais rastreadas e não commitadas em `/apps/gest-o`, evitando sobrescrever arquivos versionados do servidor sem bloquear arquivos locais ignorados como `.env`.
- O script reconstrói e sobe apenas `api` e `web`, sem derrubar volumes e sem mexer no Firebird.
- A integração ERP permanece dependente da API UltraFV3 e das variáveis já configuradas no ambiente da API.

## Como verificar uma produção presa em commit antigo

No servidor, sem expor `.env`, execute:

```bash
cd /apps/gest-o
git rev-parse HEAD
git rev-parse origin/main
git status --short
docker compose ps
```

Se `HEAD` for diferente de `origin/main`, a produção está em commit antigo. Se houver alterações rastreadas em `git status --short`, resolva ou faça backup antes de tentar novo deploy, porque o workflow não força reset.
