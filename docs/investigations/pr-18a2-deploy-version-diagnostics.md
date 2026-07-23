# PR 18A.2 — diagnóstico de versão em produção

## Baseline local

- Branch local: `work`.
- HEAD local: `6c811fbfe1c313326464454e3eecc9a5b48d2e15`, merge da PR #728.
- O checkout local não expõe `origin` em `git remote -v`; portanto, este ambiente confirma o código do merge commit local, mas não comprova por si só o estado real de produção.

## Evidências no código local

- `GET /clients/alerts/cooling` existe e está registrado antes de `GET /clients/:id`.
- `AgendaIntelligenceService` permite diretor/gerente sem `sellerId` via vendedor ativo padrão seguro e mantém `sellerId` explícito restrito a usuário vendedor ativo.
- O prompt de planejamento semanal exige português do Brasil.
- A base contém a migration/fundação 18A.1 de comunicações e os smokes associados.

## Deploy de produção versionado

O deploy automático de produção está em `.github/workflows/deploy-production.yml` e dispara em `push` para `main` ou manualmente por `workflow_dispatch`. O job acessa `/apps/gest-o`, faz `git fetch origin main`, `git checkout main`, `git pull --ff-only origin main` e executa `bash scripts/deploy-production.sh`.

O script versionado `scripts/deploy-production.sh` agora exporta para o Docker Compose:

- `APP_COMMIT`, derivado de `git rev-parse HEAD`;
- `APP_BUILT_AT`, derivado do relógio UTC do deploy;
- `APP_VERSION`, derivado do `package.json` quando não estiver definido no ambiente.

O `docker-compose.yml` propaga esses valores ao serviço `api`. Assim, a API expõe a revisão realmente injetada no build/deploy em `GET /api/health/version` e `GET /health/version`.

## Como confirmar Preview x produção sem secrets

Execute os comandos abaixo e compare `commit` com `6c811fbfe1c313326464454e3eecc9a5b48d2e15` ou o SHA curto correspondente:

```bash
curl -fsS https://<preview-host>/api/health/version | jq .
curl -fsS https://<production-host>/api/health/version | jq .
```

Se produção retornar 404 nesse endpoint após esta PR ser implantada, a stack ainda não contém a PR 18A.2. Se retornar `commit` diferente do merge da PR #728 antes desta PR, a causa primária do 404/403 é divergência de deploy, não ausência de rota/correção no código.

## Comandos somente leitura para operador de produção

```bash
cd /apps/gest-o
printf 'branch='; git branch --show-current
printf 'head='; git rev-parse HEAD
git log -5 --oneline --decorate
git status --short --branch
docker compose ps
docker compose images api web
docker compose exec -T api sh -lc 'printf "NODE_ENV=%s\nERP_SYNC_SCHEDULER_ENABLED=%s\nULTRAFV3_BASE_URL_SET=%s\nERP_CREDENTIAL_ENCRYPTION_KEY_SET=%s\nAPP_COMMIT=%s\nAPP_BUILT_AT=%s\n" "$NODE_ENV" "$ERP_SYNC_SCHEDULER_ENABLED" "${ULTRAFV3_BASE_URL:+true}" "${ERP_CREDENTIAL_ENCRYPTION_KEY:+true}" "$APP_COMMIT" "$APP_BUILT_AT"'
curl -fsS http://127.0.0.1:4000/health/version | jq .
curl -fsS http://127.0.0.1:4000/api/health/version | jq .
curl -i http://127.0.0.1:4000/api/clients/alerts/cooling
```

Para scheduler UltraFV3, usar somente endpoints/consultas de diagnóstico já autenticados na aplicação, sem exibir credenciais, tokens ou payloads sensíveis. Validar `ERP_SYNC_SCHEDULER_ENABLED`, configuração persistida, `nextRunAt`, últimos `ErpSyncRun`, `lastSuccess`, `lastError`, réplicas do serviço `api` e presença de lock `already_running` obsoleto.

## Diagnóstico do ERP 5050

Até existir acesso operacional autenticado ao ERP/produção, a investigação do cliente `5050` deve permanecer read-only e sanitizada. O fluxo esperado é confirmar se `/partners` retorna o parceiro, se o normalizador preserva o código ERP como identidade prioritária, se há cliente ativo/arquivado/duplicado no CRM, se `ownerUserId` muda sem duplicar, e se `GET /clients`/busca filtra indevidamente o registro.

## Decisão atual

- Não há evidência local suficiente para declarar produção corrigida.
- Esta PR adiciona instrumentação de release segura para eliminar a dúvida de versão em próximos deploys.
- A rota de cooling e a correção de Agenda continuam sendo as da PR #728; não foram duplicadas nem mascaradas no frontend.
