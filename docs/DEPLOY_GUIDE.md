# AVISO CANÔNICO — SCHEMA EXTERNO EM PRODUÇÃO (07/08/2026)

> O contrato vigente é `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`. Bootstrap e
> deploy da API **não** executam `prisma db push`, seed, sequence setup, DDL ou preparação do tenant.
> Use somente o fluxo futuro, administrativo e autorizado do
> [Brief OP-EXEC](sprints/SPRINT_1_0B_1_OP_EXEC_CONTROL_PLANE_CERTIFICATION.md). As seções abaixo que
> narram `db push` preservam o histórico do procedimento anterior; não são instruções vigentes. A PR
> #774 está **🟡 Merge**, sem evidência de deploy/produção; a revisão operacional comprovada segue
> `a08a626`.

# ADENDO CANÔNICO — deploy pós-recuperação (31/07/2026)

> 🔵 **PR, não produção.** O incidente permanece aberto. A topologia canônica candidata é `docker-compose.production.yml`, somente API/WEB na rede externa `gest-o_default`. O Compose genérico é legado/local e é proibido na VPS porque seu `depends_on` e fallback podem iniciar/apontar ao PostgreSQL padrão.

A divergência Git × runtime ocorreu porque o checkout chegou à `main`, mas containers históricos sem metadados continuaram nas portas. O banco vigente até migração formal é o recuperado `gest-o-db-clean-v2-20260717`, volume `gest-o_pgdata_clean_v2_20260717`, administrado separadamente. Fluxo: GitHub → workflow manual → SSH `/apps/gest-o` → preflight → build com SHA → aprovação `production-cutover` → troca só de API/WEB → Nginx host → domínio. Segredos ficam apenas em `/root/demetra-env/.env`.

```bash
# Futuro, na VPS, após aprovação; não executado nesta PR
cd /apps/gest-o
git fetch origin main && git switch main && git pull --ff-only origin main
MODE=build EXPECTED_SHA="$(git rev-parse HEAD)" bash scripts/deploy-production.sh
set -a; . /root/demetra-env/.env; set +a
bash scripts/production-schema-preview.sh > /var/log/gest-o/schema-preview.sql
MODE=cutover CONFIRM=PRODUCTION_CUTOVER EXPECTED_SHA="$(git rev-parse HEAD)" bash scripts/deploy-production.sh
```

A matriz completa e auditável de configuração está em [`PRODUCTION_ENV_MATRIX.md`](PRODUCTION_ENV_MATRIX.md). O preflight exige URL/host/container/volume esperados, database `salesforce_pro`, rede/mount, Git, disco e backup recente com SHA256, sem imprimir a URL. Como hostnames de containers são resolvidos dentro da rede Docker, a disponibilidade do PostgreSQL é testada por `pg_isready` em um container efêmero `postgres:16` conectado a `gest-o_default`, com timeout, sem senha, porta publicada, volume ou IP fixo; o DNS do host não participa. A imagem deve existir localmente e nunca é baixada pelo preflight. Isso corrige somente o falso negativo operacional do teste anterior. O build precede toda parada. O cutover registra inspect, etiqueta imagens e gera rollback; em falha reinicia os containers anteriores e nunca administra PostgreSQL. Depois, comparar `/health/version` local/público ao SHA, assets local/público, login/menu sem escrita e scheduler somente por consulta.

Containers são descartáveis: a unidade real de rollback é a imagem versionada, nunca o nome do container. Antes do cutover, API e WEB anteriores recebem tags distintas (`gest-o-api-rollback:<release>` e `gest-o-web-rollback:<release>`), e image IDs, nomes, portas, redes, restart policy e commit disponível são gravados nas evidências. O rollback persistido carrega o env seguro, remove somente os novos `api`/`web`, aguarda as portas e recria ambos via Compose com `API_IMAGE`/`WEB_IMAGE` apontando às tags salvas. Depois valida image IDs, API/WEB e reconfirma que o PostgreSQL segue running com o mesmo mount. Isso funciona tanto para containers históricos externos quanto para containers de um cutover Compose posterior, mesmo que os containers anteriores já não existam. O preview de schema executa `./node_modules/.bin/prisma` dentro de `gest-o-api:$APP_COMMIT`, sem download no host.

O bootstrap ainda executa `prisma db push`, prepara a sequence e somente então abre HTTP/scheduler; conexão/schema falhos fecham o processo. Backup e preview são gates. Uma futura adoção de `prisma migrate deploy` é recomendada, mas não integra esta correção emergencial. Para instalar o unit após aprovação: `sudo install -m 0644 docs/ops/gest-o.service /etc/systemd/system/gest-o.service && sudo systemctl daemon-reload`.

---

# Guia oficial de deploy e auditoria de produção — Gest-o

> **Escopo:** este documento descreve o que está versionado no repositório em 31/07/2026 e os comandos para comprovar o estado real da VPS. Ele não afirma ter observado a VPS, o DNS ou uma execução do GitHub Actions. Onde a configuração não está no repositório, a validação operacional é obrigatória.

## 1. Resumo executivo

- O deploy de produção é disparado por `push` em `main` (inclusive merge) ou manualmente no workflow **Deploy Production**.
- O GitHub Actions conecta por SSH à VPS, atualiza `/apps/gest-o` com fast-forward e chama `scripts/deploy-production.sh`.
- O script carrega `/root/demetra-env/.env`, injeta o SHA/data/versão da release, reconstrói as imagens `api` e `web` e recria esses containers.
- A API inicia somente depois de executar `prisma db push` e garantir a sequence de pedidos. O projeto possui SQLs em `prisma/migrations`, mas **o deploy atual não executa `prisma migrate deploy`** e, portanto, não mantém um ledger confiável de migrations aplicadas.
- O PostgreSQL usa o volume nomeado `gest-o_pgdata`. O deploy normal não recria o banco nem remove esse volume.
- O container `web` contém a build Vite e um Nginx interno. Ele encaminha `/api/` para `api:4000`. O Nginx do host/VPS e o DNS público não estão integralmente versionados; devem ser conferidos na VPS e no provedor DNS.
- Não há serviço Compose separado para worker ou scheduler. O scheduler ERP roda dentro do processo `api`; “worker” deve ser validado como inexistente no desenho atual, não como um container esperado.

## 2. Arquitetura ponta a ponta

```text
GitHub (main)
  └─ GitHub Actions: .github/workflows/deploy-production.yml
       └─ SSH :22022 (ou SSH_PORT) para a VPS
            └─ checkout /apps/gest-o
                 └─ Docker Compose (projeto derivado do diretório)
                      ├─ db: postgres:16 + volume gest-o_pgdata
                      ├─ api: Node 20, porta interna 4000, host 4000 por padrão
                      │    ├─ prisma db push no bootstrap
                      │    └─ scheduler ERP no mesmo processo
                      └─ web: Nginx Alpine + artefatos Vite, host 5173 por padrão
                           └─ /api/* → api:4000/*
            └─ Nginx do host (configuração de produção não versionada)
                 └─ TLS/domínio crm.demetraagronegocios.com.br
                      └─ DNS (configuração externa ao repositório)
```

### GitHub → VPS

O workflow usa `SSH_HOST/SSH_USER/SSH_KEY/SSH_PORT`, com fallback para `VPS_HOST/VPS_USER/VPS_KEY` e porta `22022`. Há exclusão mútua (`concurrency: deploy-production`, sem cancelamento do deploy em curso). Um merge só chega à produção se o workflow iniciar **e terminar com sucesso**. Confirmar em **Actions → Deploy Production** o run associado ao SHA do merge.

O alvo oficial versionado é `/apps/gest-o`. O unit file documentado em `docs/ops/gest-o.service` usa o mesmo diretório e pode restaurar a stack no boot. Confirmar que não há uma stack histórica em `/apps/production` ou outro Compose ainda ocupando as portas.

### VPS → Docker → API/WEB/Banco

`docker-compose.yml` não monta o código-fonte nos serviços `api` ou `web`: ambos executam conteúdo incorporado às imagens. Logo, `git pull` isolado nunca atualiza o código em execução. O único volume persistente da stack é o PostgreSQL.

O container `web` serve arquivos de `/usr/share/nginx/html`; o frontend não é servido diretamente do checkout. `VITE_API_URL` é argumento de build, portanto sua alteração também exige rebuild do `web`.

### Nginx → domínio

Há dois Nginx:

1. **interno ao container `web`**, versionado em `apps/web/nginx.conf`;
2. **do host**, que termina TLS e deve encaminhar o domínio para `${WEB_PORT:-5173}`. O vhost completo de produção não está neste repositório.

DNS e certificado são estado externo. Aponte o registro público para o IP correto da VPS e confira que o vhost efetivo usa o upstream da stack oficial. Nunca conclua que o domínio está atualizado apenas porque `curl localhost` funciona.

## 3. Procedimento oficial após merge

### Caminho automático (preferencial)

1. Mesclar em `main` e anotar o SHA completo.
2. Abrir GitHub Actions e confirmar que **Deploy Production** foi disparado para esse SHA.
3. Aguardar sucesso do job SSH. Se falhar, não considerar a release publicada.
4. Executar as verificações pós-deploy da seção 8 na VPS e externamente.

### Caminho manual controlado

O workflow pode ser disparado manualmente com `confirm_environment=production`. Para uma execução direta na VPS, esta é a ordem oficial:

```bash
set -euo pipefail
cd /apps/gest-o
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

O script repete a sincronização de forma segura e então executa, em essência:

```bash
set -a
. /root/demetra-env/.env       # quando o arquivo existe
set +a
export APP_COMMIT="$(git rev-parse HEAD)"
export APP_BUILT_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
docker compose config >/dev/null
docker compose build api web
docker compose up -d api web
docker compose ps
docker compose images api web
```

Não é necessário `docker compose restart`: `up -d` recria os containers quando a imagem mudou. Um `restart` sozinho reinicia a **imagem antiga** e não publica o merge. Não execute `down -v`, `docker volume rm`, `prisma migrate reset` nem seed em produção.

### Observações sobre o script legado

`deploy.sh` é um fluxo legado mais amplo e usa `git reset --hard origin/main`, backup e `down`. O workflow oficial chama `scripts/deploy-production.sh`, não `deploy.sh`. Não misture os dois procedimentos durante a mesma publicação; usar o legado exige uma janela operacional e entendimento dos seus safeguards.

## 4. Onde uma versão antiga pode continuar rodando

| Estado | Como acontece | Como provar/corrigir |
|---|---|---|
| Git novo, API e WEB antigas | Foi feito apenas `git pull`; containers não têm bind mount | comparar HEAD, build-info, image ID e `StartedAt`; executar o script oficial |
| Imagem nova, container antigo | `docker compose build` sem `up -d` | comparar `docker compose images` com `.Image` do container; executar `up -d api web` |
| API nova, WEB antiga | build/up parcial apenas da API, falha no build web ou stack errada | verificar os dois containers, asset hash e logs do run |
| Checkout certo, domínio antigo | Nginx aponta para outra porta/stack/VPS ou DNS aponta para outro IP | comparar resposta local, `nginx -T`, DNS e resposta externa |
| Container recriado com camada antiga | build context errado, checkout diferente, cache indevido ou arquivo fora do contexto | confirmar `WorkingDir`, SHA e conteúdo da imagem; em incidente, `docker compose build --no-cache api web` e `up -d` |
| Workflow não publicou | secrets ausentes, SSH falhou, alterações locais bloquearam fast-forward ou build falhou | logs do Actions; `git status --short --branch` na VPS |
| Ambiente antigo após reboot | unit/systemd ou outro projeto Compose sobe uma stack histórica | `systemctl cat gest-o`; listar containers, labels Compose e portas |

O caminho normal (`build` seguido de `up -d`) evita imagem/container antigos, mas o script termina logo após `compose ps`: ele **não aguarda os healthchecks nem valida o domínio**. Assim, sucesso do job não substitui o checklist pós-deploy.

## 5. Auditoria específica do frontend/menu lateral

O menu pode continuar antigo com o Git atualizado quando o `web` não foi reconstruído/recriado, quando outra stack atende o domínio, ou quando uma aba aberta ainda executa o JavaScript já carregado.

- **Build/imagem:** Vite gera assets dentro da imagem. Não há volume sobre `/usr/share/nginx/html`; atualizar o checkout não altera esses arquivos.
- **Cache HTTP:** `/index.html` e rotas SPA recebem `no-cache, no-store`; `/assets/` recebe cache de um ano e `immutable`. Isso é seguro quando Vite muda o nome/hash do asset. Torna-se problema se o HTML antigo ainda for servido ou se um artefato for publicado sob o mesmo nome.
- **Browser:** uma aba que nunca recarregou mantém o bundle em memória. Faça reload normal e, para diagnóstico, DevTools → Network → Disable cache ou janela anônima. “Hard refresh” não conserta uma imagem antiga no servidor.
- **Proxy/CDN:** não há CDN documentada. Caso exista fora do repositório, conferir/purgar seu cache somente depois de provar que origem local está nova.
- **Service worker:** a auditoria do código não encontrou registro de service worker/Workbox. Portanto, não há mecanismo PWA versionado que explique persistência offline. Confirmar no navegador em Application → Service Workers e remover qualquer registro legado do domínio, se existir.

Prova objetiva do HTML/assets:

```bash
cd /apps/gest-o
docker compose exec -T web sh -lc 'stat /usr/share/nginx/html/index.html; sed -n "1,30p" /usr/share/nginx/html/index.html'
curl -fsS http://127.0.0.1:${WEB_PORT:-5173}/ | sha256sum
curl -fsS https://crm.demetraagronegocios.com.br/ | sha256sum
curl -fsS https://crm.demetraagronegocios.com.br/ \
  | sed -nE 's/.*(assets\/[^"'"'"' ]+\.(js|css)).*/\1/p'
curl -sSI https://crm.demetraagronegocios.com.br/ | sed -n '1,20p'
```

Os hashes local e externo devem representar o mesmo `index.html` (proxies podem alterar bytes; nesse caso compare os nomes dos assets). Um teste funcional do menu deve ser feito em janela anônima após essa prova.

## 6. Confirmar o backend realmente executado

A fonte de verdade é a combinação de SHA no checkout, metadado embutido e container efetivo:

```bash
cd /apps/gest-o
EXPECTED="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
printf 'expected=%s\norigin_main=%s\n' "$EXPECTED" "$REMOTE"

docker compose ps api
docker compose images api
docker inspect "$(docker compose ps -q api)" \
  --format 'container={{.Name}} image={{.Image}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
docker compose exec -T api sh -lc 'cat apps/api/dist/build-info.json; printf "APP_COMMIT=%s\nAPP_BUILT_AT=%s\n" "$APP_COMMIT" "$APP_BUILT_AT"'
curl -fsS http://127.0.0.1:${API_PORT:-4000}/health/version
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version
```

Os campos `commit` internos e externos devem ser exatamente `$EXPECTED`, e `$EXPECTED` deve ser `origin/main`. `APP_COMMIT=unknown` significa imagem construída fora do procedimento oficial ou variável perdida; não aceite como prova de versão.

## 7. Banco e “migrations”

### O que o deploy realmente faz

O comando chamado `prisma:migrate` no `package.json` executa **`prisma db push`**. No bootstrap do container, ele sincroniza o schema Prisma diretamente e depois garante a sequence ERP. Ele não executa os SQLs em `apps/api/prisma/migrations` como uma cadeia e não registra cada pasta como aplicada.

Consequências:

- listar pastas mostra o que existe no Git, não o que foi aplicado;
- `_prisma_migrations` pode não existir, estar vazia ou refletir um processo histórico; não é prova suficiente no fluxo atual;
- a prova atual é ausência de drift entre `schema.prisma` da imagem e o banco, mais inspeção read-only dos objetos esperados;
- rollback do código pode não reverter schema, pois `db push` é progressivo e não fornece down migrations.

### Comandos de validação

```bash
cd /apps/gest-o

# Migrations disponíveis no commit (inventário, não ledger de aplicação)
find apps/api/prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql -printf '%h\n' | sort

# A tabela histórica existe? Se existir, listar sem assumir que é completa.
docker compose exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}" \
  -c "SELECT to_regclass('public._prisma_migrations');"
docker compose exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}" \
  -c 'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY finished_at;' \
  || echo '_prisma_migrations ausente/não utilizável: esperado quando o fluxo é db push'

# Drift: somente diagnóstico; não aceitar mudanças e não usar --force-reset.
docker compose exec -T api npx prisma db push --schema=apps/api/prisma/schema.prisma --skip-generate

# Conectividade e inventário read-only.
docker compose exec -T db pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}"
docker compose exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}" -c '\dt'
bash scripts/check-prod-health.sh --strict
```

Embora `db push` sem mudança normalmente seja idempotente, rode o diagnóstico de drift em janela controlada: ele é um comando de sincronização, não uma ferramenta estritamente read-only. Para auditoria read-only absoluta, compare tabelas/colunas/índices via `psql` com os SQLs versionados.

## 8. Checklist definitivo de deploy

### Antes

- [ ] Identificar SHA do merge e confirmar que pertence a `main`.
- [ ] Confirmar backup PostgreSQL recente, válido e restaurável (`./backup.sh` conforme runbook).
- [ ] Confirmar Actions/secrets SSH e janela operacional.
- [ ] Na VPS, `cd /apps/gest-o`, confirmar branch `main` e working tree limpa.
- [ ] Registrar `docker compose ps`, image IDs, `/health/version`, contagens críticas e espaço em disco.
- [ ] Validar `/root/demetra-env/.env` sem imprimir segredos e `docker compose config` (atenção: a saída completa pode revelar secrets).

### Publicação

- [ ] Executar o workflow automático ou a sequência manual oficial da seção 3.
- [ ] Confirmar rebuild bem-sucedido de **api e web**.
- [ ] Confirmar que `up -d api web` recriou ambos quando necessário.
- [ ] Não remover volumes, não resetar banco e não executar seed.

### Depois

- [ ] `git rev-parse HEAD` = `git rev-parse origin/main` = SHA planejado.
- [ ] `docker compose ps` mostra `db`, `api` e `web` em execução/healthy.
- [ ] `/health/version` local e `/api/health/version` público retornam o SHA planejado.
- [ ] API, WEB e banco passam nos comandos da seção 10.
- [ ] Asset hash do HTML público corresponde ao container `web` novo.
- [ ] Nginx do host aponta para a porta/container oficial e `nginx -t` passa.
- [ ] Domínio/TLS/DNS respondem no IP esperado.
- [ ] Scheduler, histórico ERP e UltraFV3 passam na validação autenticada.
- [ ] Teste manual mínimo: login, menu lateral, uma leitura não destrutiva e logout.
- [ ] Registrar SHA, horário, image IDs, resultado dos checks e operador.

## 9. Rollback

Rollback é uma nova publicação de um commit conhecido, preservando banco e secrets. **Não use `git reset --hard` sem confirmar/guardar alterações locais e não faça rollback cego quando houve mudança incompatível de schema.**

### Preparação

- [ ] Declarar incidente e interromper novos deploys.
- [ ] Registrar SHA atual, image IDs, logs e sintomas.
- [ ] Tirar backup validado do banco antes de qualquer ação.
- [ ] Selecionar o SHA/tag bom e revisar diferenças de `schema.prisma`/SQLs.
- [ ] Se schema for incompatível, planejar restauração do banco em janela separada; restaurar dump perde dados posteriores ao backup.

### Rollback de aplicação

Reverta o commit em `main` por PR e deixe a esteira publicar o novo SHA. Essa é a forma oficial porque mantém GitHub, checkout, metadados da imagem e histórico de produção convergentes:

```bash
git checkout main
git pull --ff-only origin main
git revert <sha-ruim>             # resolver/revisar/testar em branch e abrir PR
git push origin <branch-do-revert>
# Após aprovação e merge, acompanhar Deploy Production e executar todos os checks.
```

Não faça checkout destacado seguido de `scripts/deploy-production.sh`: por proteção, o script volta para `main`. Uma reconstrução emergencial fora de `main` não faz parte do procedimento oficial e exige runbook/aprovação específicos.

### Validação e encerramento

- [ ] Repetir integralmente o checklist pós-deploy.
- [ ] Confirmar que contagens críticas não diminuíram inesperadamente.
- [ ] Confirmar compatibilidade do schema; não rodar `migrate reset`.
- [ ] Se necessário, seguir `restore.sh`/runbook de backup somente com aprovação e indisponibilidade planejada.
- [ ] Documentar causa, período, SHA ruim/bom e eventual perda/recuperação de dados.

## 10. Health checks operacionais

Execute a partir de `/apps/gest-o`, depois de carregar o ambiente de produção sem ecoar valores.

### Stack, API e WEB

```bash
docker compose ps
docker compose ps --format json | jq .
curl -fsS http://127.0.0.1:${API_PORT:-4000}/health
curl -fsS http://127.0.0.1:${API_PORT:-4000}/health/version | jq .
curl -fsS http://127.0.0.1:${WEB_PORT:-5173}/healthz
curl -fsS https://crm.demetraagronegocios.com.br/ -o /dev/null
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq .
docker compose logs --since=10m api web
```

### Banco

```bash
docker compose exec -T db pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-salesforce_pro}" -c 'SELECT now(), current_database();'
bash scripts/check-prod-health.sh --strict
```

### Scheduler

O scheduler ERP vive no container `api`. Validar configuração sem revelar credenciais, inicialização nos logs e estado pelo endpoint autenticado:

```bash
docker compose exec -T api sh -lc 'printf "ERP_SYNC_SCHEDULER_ENABLED=%s\n" "$ERP_SYNC_SCHEDULER_ENABLED"'
docker compose logs --since=30m api | rg 'erp-sync/scheduler|scheduler'
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/scheduler/status | jq .
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/sync/history?limit=10 | jq .
```

O endpoint deve mostrar `initialized`, `enabled`, `nextRunAt`, último resultado e razão coerentes. Não interprete apenas “processo API saudável” como “scheduler executando com sucesso”.

### Worker

Não existe serviço `worker` no Compose atual. A checagem correta é provar que não há expectativa divergente:

```bash
docker compose config --services
docker compose ps -a
docker ps --filter label=com.docker.compose.project --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Se a operação espera um worker separado, isso é divergência arquitetural a ser tratada fora deste deploy; não crie ou reinicie um container ad hoc.

### UltraFV3

Primeiro confirme apenas presença de configuração (nunca imprima usuário, senha, token ou chave), depois use endpoints autenticados e read-only:

```bash
docker compose exec -T api sh -lc '
  printf "BASE_URL_SET=%s USER_SET=%s PASSWORD_SET=%s ENCRYPTION_KEY_SET=%s\n" \
    "${ULTRAFV3_BASE_URL:+true}" "${ULTRAFV3_USERNAME:+true}" \
    "${ULTRAFV3_PASSWORD:+true}" "${ERP_CREDENTIAL_ENCRYPTION_KEY:+true}"
'
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/diagnostics | jq .
TMP_ULTRAFV3="$(mktemp)"
STATUS="$(curl -sS -o "$TMP_ULTRAFV3" -w '%{http_code}' \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/healthcheck)"
jq . "$TMP_ULTRAFV3"
printf 'HTTP %s\n' "$STATUS"
rm -f "$TMP_ULTRAFV3"
```

O healthcheck pode responder `207` quando há erro operacional; registre HTTP e corpo. Não dispare sincronização, teste de pedido ou POST no ERP como mero health check.

## 11. Nginx, systemd, DNS e prova externa

```bash
sudo systemctl status gest-o --no-pager
sudo systemctl cat gest-o
sudo nginx -t
sudo nginx -T | sed -n '/server_name crm\.demetraagronegocios\.com\.br/,+100p'
sudo ss -lntp | rg ':(80|443|4000|5173)\b'
getent ahostsv4 crm.demetraagronegocios.com.br
curl -fsS https://api.ipify.org; echo
curl -vkI https://crm.demetraagronegocios.com.br/
```

Confirme: DNS resolve para a VPS esperada; certificado cobre o host e está válido; Nginx usa o upstream `${WEB_PORT:-5173}`; somente a stack em `/apps/gest-o` publica essa porta; e resposta externa contém os mesmos assets/versão verificados localmente.

## 12. Critério de aceite da auditoria

Uma release só está comprovadamente em produção quando todas as identidades convergem:

```text
SHA merge em main
= origin/main na VPS
= HEAD de /apps/gest-o
= APP_COMMIT/build-info dentro da API
= /api/health/version pelo domínio

e

imagem WEB recém-construída
= imagem do container WEB em execução
= asset hashes referenciados pelo domínio
```

Além disso, banco, proxy, scheduler e integração devem passar seus checks. “Workflow verde”, “Git atualizado” ou “container Up” isoladamente não são evidência suficiente.

## Etapa separada e obrigatória: schema de produção

O bootstrap de produção não reconcilia schema. O cutover exige evidência do apply para o mesmo SHA.
A ordem obrigatória é preflight, build, preview `MODE=validate`, aprovação humana, apply confirmado,
validação das evidências e apenas depois cutover. Use `production-schema-apply.sh`; ele aplica somente
a migration aditiva aprovada, não inicia API/WEB, não executa db push/seed e não toca em
`incident_*`. Não use `prisma migrate deploy` até o histórico do banco recuperado receber baseline
auditado. Consulte a [auditoria integral](investigations/production-schema-transition-july-2026.md).

### Pós-validação estrutural da PR #756

O apply faz diff Prisma antes e depois com `gest-o-api:<SHA>`. O diff bruto é preservado; somente os
oito drops `incident_*` conhecidos são excluídos da visão gerenciada. `post-apply-diff.sql` deve ficar
sem DDL antes da criação de `applied.tsv`. Execute `npm run test:production-schema:postgres` em CI com
Docker/PostgreSQL 16 antes de aprovar a janela.

## Autoridade explícita de schema

`NODE_ENV=production` configura o runtime da aplicação, mas não autoriza nem proíbe DDL.
`DATABASE_SCHEMA_MODE=external` é literal e obrigatório no Compose de produção: não há db push,
sequence setup ou seed/bootstrap de dados; use exclusivamente `production-schema-apply.sh`. Os
stacks descartáveis de CI/preview declaram `ephemeral-push`, permitindo criar o schema novo e executar
somente os seeds habilitados pelas flags de smoke. Valor ausente/inválido impede a API de iniciar.
