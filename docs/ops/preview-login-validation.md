# Validação prática de login no preview isolado

Este guia é focado em **prova operacional** no host/runner com Docker, sem tocar produção.

## 1) Checklist objetivo (VPS/runner)

1. Entrar no diretório do PR (`/var/www/preview/pr-<N>`).
2. Subir/reconstruir a stack isolada com `docker-compose.preview.yml`.
3. Confirmar `DATABASE_URL` efetiva dentro do container `api`.
4. Confirmar `POSTGRES_DB` do PR.
5. Confirmar `POSTGRES_VOLUME_NAME` do PR.
6. Confirmar que o admin técnico existe no banco.
7. Rodar `admin:diagnose-hash` para validar hash + senha.
8. Testar login HTTP real em `/auth/login` no `API_PORT` do PR.
9. Classificar eventual falha como:
   - ambiente
   - dado/hash
   - fluxo de autenticação

---

## 2) Comandos exatos

> Exemplo usando `PR_NUMBER=123`.

```bash
export PR_NUMBER=123
cd /var/www/preview/pr-${PR_NUMBER}
source .env
```

### 2.1 Subir o preview isolado

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.yml -f docker-compose.preview.yml up -d --build
```

**Sucesso:** containers `web`, `api`, `db` em `Up`.

**Falha:** erro de build/pull, container reiniciando, porta indisponível.

---

### 2.2 Verificar `DATABASE_URL` efetiva

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.yml -f docker-compose.preview.yml exec -T api \
  node -e 'const u=process.env.DATABASE_URL||"";const m=u.match(/postgres(?:ql)?:\/\/([^@]+@)?([^:/?#]+)(?::(\d+))?\/([^?]+)/i);console.log({hasDatabaseUrl:Boolean(u),host:m?.[2]??null,port:m?.[3]??null,database:m?.[4]??null});'
```

**Sucesso:** `hasDatabaseUrl: true` e `database = salesforce_pro_preview_pr_<N>`.

**Falha:** variável ausente ou apontando para banco fora do preview.

---

### 2.3 Verificar nome do banco do PR

```bash
echo "$POSTGRES_DB"
```

**Sucesso:** `salesforce_pro_preview_pr_<N>`.

**Falha:** nome genérico/produção/outro PR.

---

### 2.4 Verificar volume do PR

```bash
echo "$POSTGRES_VOLUME_NAME"
docker volume inspect "$POSTGRES_VOLUME_NAME" >/dev/null
```

**Sucesso:** volume existe e segue padrão por PR (`gest-o_pgdata_pr_<N>`).

**Falha:** volume ausente/compartilhado indevidamente.

---

### 2.5 Confirmar existência do admin técnico

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.yml -f docker-compose.preview.yml exec -T db \
  psql -U "${POSTGRES_USER:-postgres}" -d "$POSTGRES_DB" \
  -c "SELECT id, email, role, \"isActive\" FROM \"User\" WHERE email='${ADMIN_BOOTSTRAP_EMAIL}';"
```

**Sucesso:** retorna 1 linha do admin técnico esperado.

**Falha:** `0 rows` (bootstrap não ocorreu ou dados divergentes).

---

### 2.6 Rodar `admin:diagnose-hash`

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.yml -f docker-compose.preview.yml exec -T api \
  env ADMIN_DIAG_EMAIL="$ADMIN_BOOTSTRAP_EMAIL" ADMIN_DIAG_PASSWORD="$ADMIN_BOOTSTRAP_PASSWORD" \
  npm run admin:diagnose-hash -w @salesforce-pro/api
```

**Sucesso:** JSON com `isValidFormat: true` e `passwordMatches: true`.

**Falha:** `user_not_found`, `isValidFormat: false` ou `passwordMatches: false`.

---

### 2.7 Testar `/auth/login` com curl

```bash
curl -i -X POST "http://127.0.0.1:${API_PORT}/auth/login" \
  -H 'Content-Type: application/json' \
  --data "{\"email\":\"${ADMIN_BOOTSTRAP_EMAIL}\",\"password\":\"${ADMIN_BOOTSTRAP_PASSWORD}\"}"
```

**Sucesso:** `HTTP/1.1 200` + payload com token/sessão.

**Falha:**
- `401`: problema de dado/hash (usuário/senha)
- `5xx`/timeout: ambiente indisponível
- `404`/rota divergente: fluxo de autenticação

---

## 3) Classificação clara de falhas

- **Ambiente**: falha ao subir compose, API não saudável, conexão recusada/timeout.
- **Dado/hash**: usuário ausente, hash inválido, senha não confere.
- **Fluxo de autenticação**: endpoint retorna status inesperado com ambiente e dados já válidos.

---

## 4) Automação mínima (lacuna de observabilidade)

Para reduzir erro manual e padronizar evidência operacional:

```bash
scripts/preview/validate-login-preview.sh <PR_NUMBER>
```

Exemplo:

```bash
scripts/preview/validate-login-preview.sh 123
```

O script executa todos os checks acima e já separa as mensagens por categoria (`ambiente`, `dado/hash`, `fluxo de autenticação`).
