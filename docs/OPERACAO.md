# Desbloqueio controlado do build para o ERP Production Recovery

No run `31707019441`, o SSH, fast-forward e SHA passaram; a chamada inicial `MODE=build EXPECTED_SHA="$EXPECTED_SHA" bash scripts/deploy-production.sh` falhou de forma compatível com a ausência comprovada de `/root/demetra-env/.env`. Para **build apenas**, o resolver usa: `/root/demetra-env/.env` válido → `/root/demetra-env/production.env` válido quando o canônico está ausente → falha fechada. Não combina fontes, não contorna canônico inválido e registra somente `ERP_PRODUCTION_ENV_SOURCE=canonical|legacy_build_only`. O legado é lido sem escrita e seu `ERP_SYNC_SCHEDULER_ENABLED=false` permanece intacto. Cutover não possui fallback. Nenhuma operação produtiva foi feita nesta PR; após merge, repetir Deploy Production `phase=build` e somente então executar o workflow ERP Production Recovery aprovado, que permanece pendente.

# Validação semântica da Saúde ERP — PR #799 (13/08/2026)

O gate oficial executa testes comportamentais da projeção antes do guard estático. Na validação
read-only, conferir pais `syncAll/manual` e `automatic/scheduler`, etapas classificadas, correlação e
ausência de soma pai+filhos. Zero exige coleta `available`; sem vendedor/carteira devem aparecer
como não instrumentados. Checks verdes não comprovam execução automática produtiva. Não disparar
sync ou recovery para validar esta PR.

# Gate operacional — Saúde ERP v2 (12/08/2026)

Antes de promover esta estabilização, execute `npm run test:platform-health-erp-observability` e os
checks oficiais. Depois do deploy autorizado, validar por leitura autenticada: snapshot, histórico,
scheduler, `nextRunAt` e lock liberado. Não disparar sync/recovery como health check e não converter
manual em automática. Falha/503 deve aparecer como indisponível, nunca zero. Rollback: revert da
entrega e publicação normal somente de API/WEB; não há ação de banco.

# Operação 1.0B.2-K — prova sintética do preview

Somente o Preview Deploy executa a janela bounded de 10 ciclos × 4 chamadas. Cada request deve ter HTTP 200/exit 0, ID interno único e exatamente um MATCH; logs são limitados por timestamps e pelos 40 IDs retornados. Atraso de log tem cinco retentativas de um segundo; rate limit/timeout falham fechados. No primeiro erro, registrar metadados técnicos, restaurar `TENANCY_MODE=disabled`/`TENANT_READ_PILOT_ENABLED=false`, recriar somente a API e falhar o deploy. Rerun preserva o volume e repete seed/certificação determinísticos sem reparo automático. Esta não é operação produtiva nem autorização de soak, mutation, backfill ou cutover. Veja [Sprint 1.0B.2-K](sprints/SPRINT_1_0B_2_K_PREVIEW_SHADOW_STABILITY.md).

# GATE DOCUMENTAL — DESENVOLVIMENTO 1.0B.2 (08/08/2026)

A decisão humana explícita aprova somente o desenvolvimento incremental do estágio EXPAND:
`READY_FOR_1_0B_2_DEVELOPMENT = YES`. Operação produtiva não foi autorizada:
`READY_FOR_MULTI_TENANT_CUTOVER = NO`, `DATABASE_SCHEMA_MODE=external` e
`TENANCY_MODE=disabled`. Não executar deploy, DDL, DML, backfill ou cutover com base neste gate.
**DEVELOPMENT APPROVED ≠ PRODUCTION CUTOVER APPROVED.** Consulte o
[registro de aprovação](sprints/SPRINT_1_0B_1_GATE_APPROVAL_FOR_1_0B_2.md).

# ENCERRAMENTO OPERACIONAL — OP-EXEC (08/08/2026)

No SHA `36be802887a005431dc5e1d9f4f7129d2145f102`, a evidência operacional fornecida comprova a
conclusão do control plane default-only. Esta seção registra resultados; não é autorização nem
comando para nova execução.

- [x] schema preview;
- [x] schema apply da migration `20260802120000_tenancy_control_plane` (`APPLIED_ONCE`);
- [x] validação posterior (`ALREADY_APPLIED`, sem reaplicação; managed diff 0 bytes);
- [x] dry-run do tenant default sem DML;
- [x] revisão humana (Gate Humano 2);
- [x] tenant apply: `tenant-default-v1` e 8 memberships;
- [x] reconciliação PASS, zero tenant inesperado, órfã ou duplicidade;
- [x] remoção das autoridades temporárias, credenciais e HBA (`TEMP_ROLE_COUNT=0`,
  `TEMP_HBA_COUNT=0`).

O runtime continua `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`. Não houve cutover e
Multiempresa continua 🔴. **Próxima etapa futura:** avaliar o gate documental e humano para a
Sprint 1.0B.2; este runbook não autoriza nem fornece comandos de cutover.

# HISTÓRICO — CONTRATO DE PRODUÇÃO OP-EXEC (07/08/2026)

> **Contrato histórico preservado.** Produção deve usar
> `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`. O bootstrap da API não executa
> `prisma db push`, seed, sequence setup ou qualquer DDL/DML de preparação. Schema só muda pelo
> fluxo administrativo versionado do [Brief OP-EXEC](sprints/SPRINT_1_0B_1_OP_EXEC_CONTROL_PLANE_CERTIFICATION.md),
> com backup, preflight, preview read-only, pausa humana e confirmação separada. A PR #774 está
> **🟡 Merge**, não em produção; esta entrega está **🔵 PR**. Toda descrição posterior de bootstrap
> com `db push` documenta operação anterior e não autoriza seu uso vigente.

# ADENDO OPERACIONAL PÓS-RECUPERAÇÃO

## Control plane default-only — R2 em PR

O fluxo futuro usa `production-tenancy-control-plane-preview.sh` (somente leitura),
`production-tenancy-control-plane-apply.sh` (DDL administrativo confirmado) e
`production-tenant-default-prepare.sh` (dry-run/apply DML separados). O registry não aceita paths
livres. Esta inclusão não autoriza execução: merge/check do mesmo SHA, backup, preflight, imagem OCI
pinada, identidades aprovadas e revisão das evidências são gates. Runtime continua `disabled`.

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

## Piloto read-only Client (1.0B.2-I)

Produção: `TENANCY_MODE=disabled` e `TENANT_READ_PILOT_ENABLED=false`. O procedimento test/preview, abort e rollback está em `docs/tenancy/TENANT_READ_PILOT_OPERATION.md`; a ausência de dataset preview certificado impede ativação nesta entrega.

### Piloto Client no Preview (1.0B.2-J)
Executar `npm run test:tenant-read-pilot-preview-seed`. A ativação é exclusiva do workflow preview e posterior aos checkpoints de seed/dataset. Em abort/MISMATCH, restaurar `TENANT_READ_PILOT_ENABLED=false` e `TENANCY_MODE=disabled`, recriar somente a API preview e confirmar ausência de evento shadow; nunca inspecionar payload ou acessar produção.
# Preflight tenant data readiness (somente ambiente descartável)

Execute `npm run test:tenant-data-readiness` e, com Docker, `npm run test:tenant-data-readiness:postgres`. O segundo comando recusa `DATABASE_URL`, não publica porta e deve terminar em `TENANT_DATA_READINESS_POSTGRES=PASS`. Não aponte esse harness à produção e não interprete PASS sintético como prontidão produtiva. Rollback é reverter código/gate; não existe rollback de dados porque o diagnóstico não escreve.
# Planejamento gated 1.0B.2-M

Executar `npm run test:preflight-gated-backfill-plan` e, em host Docker isolado, `npm run test:preflight-gated-backfill-plan:postgres`. O harness recusa `DATABASE_URL` herdada e não publica porta. READY gera apenas plano `dryRunOnly`; nunca autoriza apply. BLOCKED, quarentena, evidência expirada/adulterada ou replay conflitante exigem preservar hashes e códigos sanitizados, interromper e obter nova evidência formal. Rollback remove apenas tooling/gate/documentação; não existe DML ou ledger produtivo a desfazer.
# Prova descartável 1.0B.2-N

Execute `npm run test:preflight-plan-ledger:postgres` somente em host Docker de desenvolvimento/CI,
sem `DATABASE_URL` ou `TEST_DATABASE_URL`. O runner cria `postgres:16` sem porta, valida concorrência,
SQLSTATE, crash, grants e catálogo, desfaz todo o DDL e exige
`PREFLIGHT_PLAN_LEDGER_POSTGRES=PASS`. Nunca aponte esse harness para produção.

O head remoto `029fab54d32413d0e94308227c0ae591144b7ee7` foi comprovado no Preview Deploy
31432019343 e no Docker Compose CI 31432019733 (`compose-smoke` 93597451158), ambos PASS. Isso
certifica o procedimento descartável, não autoriza executar o candidato fora do CI/desenvolvimento.

## Controles duráveis dos harnesses

- `pg_isready` não prova que o database solicitado aceita sessão: readiness autoritativa abre o
  database exato com `psql -X`, `ON_ERROR_STOP=1`, `SELECT 1`, exit zero e stdout literal validado.
- Constraints sobrepostas tornam `ON CONFLICT` parcial inadequado para replay concorrente. Evidência
  e plano usam advisory transaction locks namespaced, ordem determinística, replay
  `IDEMPOTENT_REPLAY` e conflito divergente `23505`.
- Papel e grants são auditados respectivamente por `pg_catalog.pg_roles` e
  `information_schema.table_privileges`, sobre inventário fechado e literal — nunca por `LIKE`.
- Cada concorrência captura dois PIDs, waits, exit codes e stdout/stderr separados; `HARNESS_STEP` e
  `HARNESS_COMMAND` mudam antes de cada fase para impedir diagnóstico stale.
- Cenários usam IDs/hashes exclusivos; `p3` é reservado ao crash/rollback. O teardown é testado com
  rollback, executado realmente e seguido de comparação exata com o catálogo baseline.
# Recuperação controlada do scheduler UltraFV3

O workflow manual **ERP Production Recovery** é exclusivo para `INC_ERP_5050`. Ele não substitui o
deploy geral. Antes de dispará-lo, mescle a PR de recuperação, execute a fase `build` do workflow
**Deploy Production** para o mesmo SHA e confirme que a imagem `gest-o-api:<SHA>` foi preparada na
VPS. Em **Actions → ERP Production Recovery → Run workflow**:

1. selecione a branch `main` já mesclada;
2. informe `confirm` exatamente como `RESTORE_ERP_AUTOMATIC_SYNC`;
3. informe em `expected_main_sha` os 40 caracteres do SHA aprovado da `main`;
4. aguarde a aprovação humana do environment `production-cutover`;
5. acompanhe somente os checkpoints sanitizados do job.

As credenciais do login de validação são os secrets `AUTH_TEST_EMAIL` e `AUTH_TEST_PASSWORD` do
environment `production-cutover`. Elas entram somente na memória da sessão SSH, não são inputs do
dispatch, não pertencem a `/root/demetra-env/.env` e não são persistidas em evidências. Antes de criar
backup, candidato ou alterar containers, o script exige essas entradas, descobre a única API/WEB em
execução, deriva a imagem WEB real e comprova `gest-o-api:<expected_main_sha>` e sua label de revisão.

O job atualiza `/apps/gest-o` exclusivamente por fast-forward, exige igualdade do SHA e executa
`scripts/erp-production-recovery.sh`. O script inspeciona apenas metadados dos caminhos canônico e
legado, cria backups protegidos, altera atomicamente somente `ERP_SYNC_SCHEDULER_ENABLED`, executa os
dois preflights e valida o Compose sem mostrá-lo. Depois preserva a imagem anterior e as identidades
de WEB/PostgreSQL/volume, recria somente `api` com `--no-deps --no-build --force-recreate`, valida
health, login, configuração persistida, credencial global ou de vendedor de referência, lock e
`nextRunAt`, e aguarda de forma bounded uma execução real com `trigger=scheduler`.

O gate `ERP_SYNC_SCHEDULER_ENABLED` deve existir exatamente uma vez na fonte protegida. Ausência ou
duplicidade aborta a preparação; a recuperação não cria um contrato de env incompleto implicitamente.

Interpretação operacional:

- `ERP_ENV_RECOVERY_SOURCE=NOT_AVAILABLE`: abort antes de container; nenhuma credencial é criada;
- checkpoints `=PASS`: aquela validação foi comprovada, mas o incidente só pode ser resolvido quando
  também houver `ERP_AUTOMATIC_SYNC=PASS`, `ERP_SYNC_LOCK=RELEASED` e persistência do env;
- `ERP_RECOVERY_ROLLBACK=STARTED/COMPLETED`: uma validação crítica falhou; env e API anteriores foram
  restaurados, e `INC_ERP_5050` continua `INVESTIGATING`;
- ausência do resultado final: tratar como falha/interrupção, revisar o estágio sanitizado e não
  repetir até verificar health e a exclusão mútua do workflow.

O rollback é automático para health, login, scheduler, `nextRunAt`, credencial de referência, lock,
múltiplas APIs ou expiração da janela automática. É proibido disparar sincronização manual como
prova, executar `down`, remover volumes, recriar WEB/PostgreSQL, rodar migrations, `prisma db push`,
seed ou backfill. O job nunca aceita secrets como inputs nem imprime env, resposta de login ou dados
empresariais.

### Interpretação do lock ERP

`ErpSyncLock` usa uma linha exclusiva por escopo. A aquisição cria a linha ou assume atomicamente uma
linha cujo `lockedUntil` já expirou; não há renovação periódica. A liberação remove a linha por
`scope+runId` no `finally`. Assim, linha futura é lock ativo legítimo e bloqueia a recriação; linha
expirada é `expired_recoverable`, não “órfã” automática; ausência após a execução é `free/released`.
Crash pode deixar a linha até o TTL, quando a próxima aquisição pode recuperá-la. A prova continua
exigindo execução `scope=automatic`, `trigger=scheduler`, sucesso posterior à recriação e estado final
sem linha de lock.
# Diagnóstico observável antes do build — run 31713219051

O run fez fast-forward até `443be81e35a15e37158a93161b105c1aa81690b2` e parou no antigo
`test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"`, antes do resolver. O log não registrou os operandos,
logo não autoriza afirmar qual deles divergiu. Em uma futura execução autorizada, exigir na ordem
`DEPLOY_GIT_FETCH`, `DEPLOY_GIT_SWITCH`, `DEPLOY_GIT_FAST_FORWARD`,
`DEPLOY_EXPECTED_SHA_FORMAT`, `DEPLOY_CHECKOUT_SHA_MATCH`, `DEPLOY_WORKTREE_CLEAN`,
`DEPLOY_SCRIPT_PRESENT` e `DEPLOY_SCRIPT_STARTING=build`. Ausência ou `FAIL` bloqueia o deploy e deve
ser analisada pelos campos sanitizados `DEPLOY_FAILURE_*`. Esta correção não autoriza retry, cutover
ou Recovery; nenhuma dessas operações foi executada.
# Run 31720219813 — procedimento de retomada do build

No job `94515047904` (SHA `a3f900b05cbbcc2ab9ee8bba306c4a2cea524d97`), os checkpoints
`DEPLOY_GIT_FAST_FORWARD`, `DEPLOY_EXPECTED_SHA_FORMAT`, `DEPLOY_CHECKOUT_SHA_MATCH`,
`DEPLOY_WORKTREE_CLEAN`, `DEPLOY_SCRIPT_PRESENT`, entrada/`MODE=build`, resolução
`legacy_build_only` e scheduler desativado passaram. A execução parou no preflight:
`TENANCY_MODE does not match the production policy`. Não houve build/cutover/Recovery nem acesso ou
mudança de produção.

O deploy cria o env efetivo somente para `MODE=build + legacy_build_only`, fora do checkout e do
diretório canônico, mode 600, com cleanup por trap. Ele rejeita gates duplicados/malformados,
normaliza somente a cópia, executa preflight/Compose/build com ela e comprova a imutabilidade da
fonte por SHA-256. O cutover rejeita legado e overlay; canônico inválido nunca usa fallback. Após
merge e checks verdes, a única retomada autorizada é repetir Deploy Production com `phase=build`.
