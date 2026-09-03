## Runbook vigente (03/09/2026)

O workflow é exclusivamente manual em **Actions → Deploy Production**. `phase=build` executa preflight e build sem parar containers; `phase=cutover` exige aprovação do environment e só então pode trocar API/WEB. A ordem obrigatória é checks da main → Prepare Production Recovery Backup → build → conferir SHA → cutover/aprovação → validar API, WEB, banco e SHA. Merge/CI e build verde não significam deploy. Não use Recovery, canonical environment ou workflow de schema por tentativa. Não copie/crie evidência. Consulte `DOCUMENTO_MESTRE.md` para gates, resposta operacional, pós-checks e rollback.

# Deploy de produção

## Bloqueio operacional: tenancy expand roots

Em 1 de setembro de 2026, `20260808120000_tenancy_expand_roots` ainda não havia
sido aplicada; em 2 de setembro o apply foi confirmado verde e publicou o bundle
protegido descrito abaixo. A migration possui operação manual exclusiva em
`.github/workflows/production-tenancy-expand-roots.yml`: primeiro `preview`
read-only; depois, somente com evidência verde, backup e aprovação do environment
`production-schema`, `apply` com a confirmação `APPLY_TENANCY_EXPAND_ROOTS`.

O escopo é apenas expand-only: onze colunas nullable, índices e foreign keys.
Backfill, tenant padrão, membership, read pilot e qualquer mudança de
`TENANCY_MODE=disabled` não estão autorizados. Isso não ativa multi-tenancy e não
deve ser combinado com o apply PR827, que já está aplicado e deve ser preservado.

O cutover da aplicação continua bloqueado antes de `docker stop` até que o
preview produtivo, o apply administrativo e o post-diff produtivo estejam verdes.
Merge deste código, isoladamente, não autoriza o cutover nem execução em produção.

Este repositório possui um workflow seguro para atualizar a produção em `/apps/gest-o` após alterações entrarem na branch `main`.

## Diagnóstico do fluxo atual

- O preview é implantado pelo workflow `Preview Deploy`, acionado em eventos de `pull_request`, em diretórios isolados por PR no servidor.
- A produção deve acompanhar a branch `main` no diretório `/apps/gest-o` e servir o frontend em `crm.demetraagronegocios.com.br`.
- Quando a produção permanece em um build antigo depois do merge, o cenário mais provável é que o deploy de produção via GitHub Actions não tenha sido executado com sucesso, esteja sem secrets de SSH, ou o diretório `/apps/gest-o` esteja bloqueando o fast-forward por alterações locais.
- O script legado `deploy.sh` usa `git reset --hard origin/main`; ele deve ser evitado em automações sem uma janela operacional explícita porque pode sobrescrever alterações locais do servidor.

## Workflow

Arquivo: `.github/workflows/deploy-production.yml`.

Gatilho: somente `workflow_dispatch`, com escolha explícita de `build` ou
`cutover`. Não existe deploy automático em `push` para `main`.

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

O entrypoint confere SHA e worktree; o script executa preflight e build. Apenas
quando `phase=cutover`, depois da aprovação e dos gates, ele troca API/WEB:

```bash
cd /apps/gest-o
APP_DIR=/apps/gest-o bash scripts/production-deploy-entrypoint.sh
```

## Segurança operacional

- Não há secrets versionados no repositório.
- O script não altera nem recria `.env`.
- O script não roda `git reset --hard`.
- A API executa o bootstrap de schema no startup (`prisma db push` + garantia da sequence de pedidos) antes de abrir o servidor; se essa etapa falhar, o container encerra e o healthcheck não libera a API.
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
> **Atualização de 2 de setembro de 2026 — bundle tenancy expand roots.** O gate de
> cutover reconhece explicitamente o bundle protegido
> `<SCHEMA_EVIDENCE_DIR>/<APP_COMMIT>/migrations/20260808120000_tenancy_expand_roots`.
> O contrato compartilhado valida a árvore sem symlinks, owner/modes, allowlist exata,
> metadata, checksum contra registro/checkout/commit, resultado, catálogo e o diff
> gerenciado com `schema-diff-filter.mjs`. O SQL bruto pode conter apenas diferenças
> históricas removidas pelo filtro; seu tamanho não é um gate. `applied.tsv` continua
> sendo validado sem alteração para os fluxos legados. Depois da evidência, o deploy
> ainda executa o Prisma diff ao vivo com a imagem pinada e `DATABASE_URL` protegido,
> antes de parar containers.
