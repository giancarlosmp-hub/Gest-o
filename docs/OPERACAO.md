# ADENDO OPERACIONAL PÓS-RECUPERAÇÃO

> 🔵 PR ainda não aplicada. Use exclusivamente `scripts/deploy-production.sh` e `docker-compose.production.yml` em futura janela aprovada. O PostgreSQL recuperado permanece separado; o Compose genérico é proibido para deploy. Preflight, cutover, rollback, evidências e comandos exatos estão no adendo de `DEPLOY_GUIDE.md`. O incidente não está encerrado.


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
