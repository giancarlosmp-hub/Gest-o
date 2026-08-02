# ADENDO OPERACIONAL PÓS-RECUPERAÇÃO

> 🔵 PR ainda não aplicada. Use exclusivamente `scripts/deploy-production.sh` e `docker-compose.production.yml` em futura janela aprovada. O PostgreSQL recuperado permanece separado; o Compose genérico é proibido para deploy. Preflight, cutover, rollback, evidências e comandos exatos estão no adendo de `DEPLOY_GUIDE.md`. O incidente não está encerrado.

O preflight corrige um falso negativo sem alterar a produção: como o hostname do PostgreSQL existe somente no DNS da rede Docker, a sondagem usa um container efêmero local `postgres:16`, sem pull automático, dentro de `gest-o_default`. Ela não consulta o DNS do host, não fixa IP e não recebe senha nem a `DATABASE_URL`. Nenhum deploy foi realizado; o estágio permanece 🔵 PR.


**Rollback:** nomes de containers não são artefatos de release. Antes de cada cutover, as imagens anteriores de API e WEB são etiquetadas separadamente e inventariadas. O rollback remove somente API/WEB novas e recria os serviços com as tags salvas; não depende de o container anterior existir e não administra o PostgreSQL. Consulte `DEPLOY_GUIDE.md`.

---

# Operação pós-merge do Gest-o

> **Pergunta que este runbook responde:** “Acabei de mesclar uma PR. O que faço agora?”

Este é o roteiro curto e executável do operador. A explicação completa da arquitetura, dos riscos, do rollback e dos diagnósticos está em [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md).

## Resposta rápida

```text
anotar o SHA do merge
        ↓
acompanhar o workflow Deploy Production
        ↓
confirmar Git da VPS
        ↓
confirmar build e containers
        ↓
confirmar schema do banco
        ↓
health checks
        ↓
smoke tests
        ↓
confirmar commit da API
        ↓
confirmar frontend/menu
        ↓
confirmar scheduler e UltraFV3
        ↓
registrar o resultado
```

Para as correções já mescladas de segurança e restore, a ordem não cria um segundo deploy nem
mistura recuperação à publicação: **deploy oficial → convergência do SHA → validação read-only de
segurança → estabilidade → restore descartável em etapa separada e novamente autorizada**. Após o
deploy, use o [Brief da Sprint 0.4](sprints/SPRINT_0_4_SECURITY_RESTORE_OPERATIONAL_VALIDATION.md) e
`scripts/production-auth-security-validate.sh`; o restore nunca integra o deploy ou seu rollback.

## Regra principal

Um merge em `main` dispara automaticamente o workflow **Deploy Production**. O caminho preferencial é acompanhar esse workflow, não executar um segundo deploy em paralelo.

O deploy só está concluído quando:

1. o workflow terminou com sucesso;
2. o SHA em `origin/main`, na VPS, dentro da API e no domínio é o mesmo;
3. API, WEB e banco estão saudáveis;
4. o frontend público contém a build nova;
5. o scheduler está inicializado e coerente.

“PR mesclada”, “Git atualizado”, “workflow verde” e “container Up”, isoladamente, **não** comprovam que a versão chegou à produção.

## 1. Antes de começar

No GitHub, copie o SHA completo do merge e guarde-o como `SHA_ESPERADO`. Na VPS:

```bash
export SHA_ESPERADO='<sha-completo-do-merge>'
cd /apps/gest-o
set -a
[ ! -f /root/demetra-env/.env ] || . /root/demetra-env/.env
set +a
```

Não continue sem saber qual SHA deve estar em produção.

Também confirme:

- que ninguém está executando outro deploy;
- que o backup de produção está recente e válido;
- que não há incidente ativo no banco ou no UltraFV3;
- que há espaço disponível para construir novas imagens:

```bash
df -h
docker system df
```

## 2. Acompanhar o deploy automático

1. Abra **GitHub → Actions → Deploy Production**.
2. Localize a execução associada ao merge em `main`.
3. Confira que o job entrou em `/apps/gest-o`.
4. Aguarde o término do build de `api` e `web`.
5. Se o workflow falhar, pare e examine o log. Não trate a release como publicada.

O workflow executa remotamente:

```bash
cd /apps/gest-o
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

## 3. Deploy manual, somente quando necessário

Use esta opção quando o deploy automático não tiver sido disparado e não houver outro job em execução. Preferencialmente, use **Run workflow**, informe `production` e acompanhe o GitHub Actions.

Se for necessário operar diretamente na VPS:

```bash
set -euo pipefail
cd /apps/gest-o
git status --short --branch
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

O script oficial executa a sequência equivalente a:

```bash
git pull --ff-only origin main
        ↓
docker compose build api web
        ↓
docker compose up -d api web
        ↓
bootstrap da API: prisma db push
        ↓
bootstrap da API: garantia da sequence ERP
        ↓
API começa a atender e inicia o scheduler ERP
```

### Importante sobre migrations

Não há um comando adicional de migration para o operador rodar depois do `up`.

O container `api` executa automaticamente `prisma db push` **antes de abrir a API**. Embora existam arquivos SQL em `apps/api/prisma/migrations`, o deploy atual não usa `prisma migrate deploy`. Portanto:

- não rode `prisma migrate deploy` manualmente como parte deste fluxo;
- não rode `prisma migrate reset`;
- não rode `docker compose down -v`;
- não remova `gest-o_pgdata`;
- não execute seed em produção.

Se `prisma db push` falhar, o container da API deve falhar/reiniciar e o deploy deve ser considerado malsucedido.

## 4. Confirmar Git, imagens e containers

```bash
cd /apps/gest-o
git fetch origin main

printf 'esperado:    %s\n' "$SHA_ESPERADO"
printf 'checkout:    %s\n' "$(git rev-parse HEAD)"
printf 'origin/main: %s\n' "$(git rev-parse origin/main)"
git status --short --branch

docker compose ps
docker compose images api web
docker inspect "$(docker compose ps -q api)" \
  --format 'api image={{.Image}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
docker inspect "$(docker compose ps -q web)" \
  --format 'web image={{.Image}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
```

Pare se `HEAD`, `origin/main` e `SHA_ESPERADO` forem diferentes. `api`, `web` e `db` devem estar ativos; aguarde os healthchecks ficarem `healthy`.

## 5. Confirmar banco/schema

O check operacional mínimo é:

```bash
docker compose exec -T db \
  pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}"

bash scripts/check-prod-health.sh --strict

docker compose logs --since=15m api \
  | rg 'prisma db push|Database is now in sync|ERP order sequence|SCHEMA BOOTSTRAP FAILED|DB CONNECTION FAILED'
```

Resultado esperado:

- `pg_isready` aceita conexões;
- o check de tabelas críticas termina com sucesso;
- os logs não contêm `SCHEMA BOOTSTRAP FAILED` nem `DB CONNECTION FAILED`;
- o bootstrap registra a sincronização do schema e a preparação da sequence ERP.

O projeto não possui hoje um ledger confiável de “última migration aplicada”, pois usa `db push`. Para a auditoria detalhada de `_prisma_migrations`, drift e objetos SQL, siga a seção **Banco e migrations** do [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md).

## 6. Health checks da API e da WEB

Execute:

```bash
curl -fsS "http://127.0.0.1:${API_PORT:-4000}/health"
curl -fsS "http://127.0.0.1:${API_PORT:-4000}/health/version" | jq .
curl -fsS "http://127.0.0.1:${WEB_PORT:-5173}/healthz"

curl -fsS https://crm.demetraagronegocios.com.br/ -o /dev/null
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq .
```

Qualquer erro HTTP, timeout ou JSON inválido bloqueia a conclusão do deploy.

## 7. Confirmar o commit realmente executado

```bash
COMMIT_CONTAINER="$(docker compose exec -T api \
  node -p "require('./apps/api/dist/build-info.json').commit" | tr -d '\r')"
COMMIT_LOCAL="$(curl -fsS "http://127.0.0.1:${API_PORT:-4000}/health/version" | jq -r .commit)"
COMMIT_PUBLICO="$(curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq -r .commit)"

printf 'esperado:  %s\ncontainer: %s\nlocal:     %s\npúblico:   %s\n' \
  "$SHA_ESPERADO" "$COMMIT_CONTAINER" "$COMMIT_LOCAL" "$COMMIT_PUBLICO"

test "$COMMIT_CONTAINER" = "$SHA_ESPERADO"
test "$COMMIT_LOCAL" = "$SHA_ESPERADO"
test "$COMMIT_PUBLICO" = "$SHA_ESPERADO"
```

Os três `test` devem terminar com status zero. `unknown`, SHA antigo ou respostas divergentes significam que a publicação não foi comprovada.

## 8. Smoke tests

### Smoke técnico, sem alterar dados

```bash
curl -fsS https://crm.demetraagronegocios.com.br/ | head -n 5
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq .
docker compose logs --since=10m api web | rg -i 'error|exception|fatal|unhealthy' || true
```

O último comando é diagnóstico: examine cada ocorrência; `rg` encontrar a palavra `error` não significa automaticamente falha, pois pode haver mensagens históricas ou respostas externas tratadas.

### Smoke funcional no navegador

Em janela anônima:

- [ ] abrir `https://crm.demetraagronegocios.com.br`;
- [ ] autenticar com um usuário operacional de teste autorizado;
- [ ] confirmar que o menu lateral corresponde à PR mesclada;
- [ ] navegar por uma tela de leitura;
- [ ] confirmar que não há erro no console nem requisições 5xx;
- [ ] sair da sessão.

Não crie, altere, sincronize ou exclua dados apenas para provar o deploy, salvo se existir um caso de teste previamente aprovado.

## 9. Confirmar frontend e menu

O Git atualizado não atualiza sozinho o frontend: os assets Vite ficam dentro da imagem `web`. Compare o HTML servido pelo container e pelo domínio:

```bash
HTML_LOCAL="$(mktemp)"
HTML_PUBLICO="$(mktemp)"

curl -fsS "http://127.0.0.1:${WEB_PORT:-5173}/" -o "$HTML_LOCAL"
curl -fsS https://crm.demetraagronegocios.com.br/ -o "$HTML_PUBLICO"

printf '%s\n' 'Assets locais:'
rg -o 'assets/[^" ]+\.(js|css)' "$HTML_LOCAL" | sort -u
printf '%s\n' 'Assets públicos:'
rg -o 'assets/[^" ]+\.(js|css)' "$HTML_PUBLICO" | sort -u

rm -f "$HTML_LOCAL" "$HTML_PUBLICO"
```

As listas devem ser equivalentes. Depois, confirme visualmente o menu em janela anônima.

Se o menu permanecer antigo:

1. confira o image ID e `StartedAt` do `web`;
2. confira se os assets públicos são os mesmos do container;
3. confira `sudo nginx -T` e o upstream do domínio;
4. confira se existe outra stack ocupando a porta;
5. teste janela anônima/DevTools com cache desabilitado;
6. confira Application → Service Workers — não há service worker versionado, mas pode existir registro legado no navegador.

## 10. Confirmar scheduler

O scheduler ERP não é um container separado: ele roda dentro de `api`. Também não existe um serviço Compose separado chamado `worker`.

```bash
docker compose config --services
docker compose exec -T api sh -lc \
  'printf "ERP_SYNC_SCHEDULER_ENABLED=%s\n" "$ERP_SYNC_SCHEDULER_ENABLED"'
docker compose logs --since=30m api | rg 'erp-sync/scheduler|scheduler'
```

Com um token administrativo autorizado, valide o estado persistido sem disparar sincronização:

```bash
test -n "${ADMIN_ACCESS_TOKEN:-}"
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/scheduler/status | jq .
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  'https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/sync/history?limit=10' | jq .
```

Confirme `initialized`, `enabled`, `nextRunAt`, último sucesso/erro e `reasonCode`. API saudável não garante, por si só, que o scheduler executou com sucesso.

## 11. Confirmar UltraFV3 sem executar operações

```bash
docker compose exec -T api sh -lc '
  printf "BASE_URL_SET=%s USER_SET=%s PASSWORD_SET=%s KEY_SET=%s\n" \
    "${ULTRAFV3_BASE_URL:+true}" "${ULTRAFV3_USERNAME:+true}" \
    "${ULTRAFV3_PASSWORD:+true}" "${ERP_CREDENTIAL_ENCRYPTION_KEY:+true}"
'

curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/diagnostics | jq .
```

Não imprima credenciais ou tokens e não use POST de pedido/sincronização como health check.

## 12. Encerrar e registrar

Registre no ticket, PR ou diário operacional:

```text
Deploy UTC:
Operador:
PR:
SHA esperado:
SHA checkout:
SHA API local:
SHA API pública:
Image ID API:
Image ID WEB:
Banco:
API:
WEB:
Menu:
Scheduler:
UltraFV3:
Observações:
```

Marque o deploy como concluído somente quando todos os itens obrigatórios estiverem confirmados.

## Se algo falhar

1. Pare; não execute comandos destrutivos para “tentar de novo”.
2. Preserve logs, SHA e image IDs.
3. Determine se a falha está no Git, build, container, banco, Nginx, DNS ou navegador.
4. Consulte os cenários de versão antiga e o checklist de rollback em [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md).
5. Para rollback, prefira um revert revisado e mesclado em `main`; nunca use `down -v`, `migrate reset` ou remoção do volume do banco.

## Gate operacional de schema antes do cutover

Não use `prisma db push` em produção. Depois de preflight e build, execute o preview com
`MODE=validate`, revise todo o SQL e, com aprovação humana/backup SHA256, execute separadamente
`CONFIRM=PRODUCTION_SCHEMA_APPLY bash scripts/production-schema-apply.sh`. Revise logs, hash,
`applied.tsv`, objetos criados e contagens `incident_*` em `/var/log/gest-o/schema/<SHA>/`. Só uma
janela posterior pode executar cutover. Rollback de containers não reverte schema; nunca apague
volume ou tabela de incidente. Comandos completos: [investigação](investigations/production-schema-transition-july-2026.md).

### Evidência estrutural pós-apply

Revisar `pre-apply-diff.raw.sql`, `pre-apply-managed-diff.sql`, `post-apply-diff.raw.sql` e o
`post-apply-diff.sql` vazio. O raw pós-apply pode conter exclusivamente os oito drops históricos que
o Prisma propõe por não gerenciá-los; qualquer outro DDL impede `applied.tsv` e o cutover.

## `DATABASE_SCHEMA_MODE`

- Produção real: `external`, fixo no `docker-compose.production.yml`; alteração de schema somente pelo
  apply separado e nunca por bootstrap.
- CI/preview descartável: `ephemeral-push`, explícito no Compose/workflow; o banco novo recebe `db
  push` antes de admin/smoke/preview seed.

`NODE_ENV` não é sinal de propriedade do banco. Nunca mude produção para `ephemeral-push`, nem use
flags de seed como autorização indireta. Ausência ou valor inválido deve falhar fechado.


## Validação operacional Enterprise — Sprint 0.5

A pergunta “esta instalação está saudável?” possui uma única rotina oficial. Ela é somente leitura,
não consulta o banco e não substitui deploy, restore, monitoramento prolongado ou decisão humana.
Execute apenas no host autorizado, depois de confirmar o SHA por fonte independente e preparar uma
conta de teste com privilégio mínimo. Não publique credenciais nem os logs brutos.

```bash
cd /apps/gest-o
EXPECTED_SHA='<sha-completo-esperado>' \
CONFIRM=PRODUCTION_HEALTH_VALIDATE \
AUTH_TEST_EMAIL="$AUTH_TEST_EMAIL" \
AUTH_TEST_PASSWORD="$AUTH_TEST_PASSWORD" \
DB_VOLUME='<volume-postgresql-aprovado>' \
SCHEMA_EVIDENCE_FILE='<applied.tsv-ou-manifesto-aprovado>' \
bash scripts/production-health-validation.sh
```

Pré-condições: checkout limpo no SHA, Docker disponível, containers conhecidos, DNS/TLS público,
evidência anterior de schema legível e diretório `/var/log/gest-o/health` gravável pelo operador.
A rotina falha se o diretório daquele SHA já existir, evitando sobrescrever prova. As credenciais e
token ficam somente em memória. O arquivo de schema é lido como evidência externa: nenhuma conexão
PostgreSQL é aberta.

A revisão deve conferir `health.tsv`, `runtime.tsv`, `containers.tsv`, `images.tsv`, `network.tsv`,
`storage.tsv`, `system.tsv`, `security.tsv`, `erp.tsv` e `summary.tsv`. `result.tsv` é criado somente
depois de todas as verificações; qualquer `FAIL` significa instalação **não certificada**, exige
triagem e não autoriza ação corretiva automática. Ausência de Docker é SKIP apenas no ambiente de
desenvolvimento/CI e nunca equivale a PASS operacional. Preserve permissões 0700 e não anexe
credenciais, corpos de autenticação ou logs brutos a tickets.

## Ordem futura — control plane default-only (Sprint 1.0B.1-OP)

Esta sequência **ainda não foi executada** e não pertence ao cutover: (1) atualizar `main`; (2) build da imagem pinada; (3) backup/preflight; (4) preview read-only; (5) apply confirmado apenas da migration registrada `20260802120000_tenancy_control_plane`; (6) dry-run do tenant default; (7) revisão humana das evidências sem PII; (8) apply DML confirmado e separado; (9) reconciliação; (10) confirmar runtime disabled; (11) não executar cutover; (12) só então avaliar 1.0B.2. Os campos operacionais de alvo, backup e credencial administrativa devem ser preenchidos no host autorizado; esta documentação não autoriza comandos de VPS.

As quatro autoridades não iniciam/paralisam API/WEB, não fazem seed/db push, não alteram `production.env` e não habilitam tenancy no Compose. Consulte o [Brief](sprints/SPRINT_1_0B_1_OP_CONTROL_PLANE_OPERATION.md).
