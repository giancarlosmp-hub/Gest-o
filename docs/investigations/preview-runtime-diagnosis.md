# Diagnóstico técnico — ambiente de Preview (PR)

## Escopo
Diagnóstico **somente de leitura** para identificar por que o preview alterna entre:
1. **"Servidor indisponível"**
2. **"Login inválido"**

Sem alteração de código e sem correção automática.

---

## Resumo executivo

### Causa raiz
O workflow de preview atual está **incompleto**: ele não faz deploy real da stack (não clona/atualiza código do PR e não executa `docker compose up -d`).

Com isso, o host de preview pode apontar para porta sem container ativo (gerando "Servidor indisponível") ou para um ambiente antigo/sem dados (gerando 401 no login, exibido no frontend como "Login inválido").

### Classificação infra vs dados
- **Problema principal: INFRA/PROVISIONAMENTO** (workflow preview incompleto).
- **Efeito secundário: DADOS** (ambiente sem usuário válido quando sobe com banco vazio/legado).

### Ação exata recomendada (única)
**Implementar deploy determinístico no `.github/workflows/preview.yml`, no servidor de preview, para cada PR: `git fetch/checkout` da branch do PR + `docker compose up -d --build` no diretório `/var/www/preview/pr-<N>` (com `.env` completo), garantindo que WEB/API/DB do PR realmente subam.**

---

## Diagnóstico por hipótese solicitada

## 1) API não rodando
**Status:** altamente provável em parte das execuções.

**Evidência:** o workflow de preview não executa comando de subida de containers (`docker compose up`) nem comando de deploy de código do PR. Ele roda apenas debug remoto e comenta URL no PR.

**Impacto observado:** sem container web/api ouvindo na porta do PR, o Nginx de preview retorna página de indisponibilidade.

---

## 2) Erro de conexão frontend → API
**Status:** não é a causa primária.

**Evidência técnica:**
- frontend em produção usa `VITE_API_URL` (fallback `/api`),
- `nginx.conf` do web faz proxy de `/api/` para `http://api:4000/`,
- backend expõe rotas com e sem prefixo `/api` (incluindo `/api/auth/login`).

Isso indica que, **quando a stack está de pé**, a topologia frontend→API está coerente.

---

## 3) Banco vazio
**Status:** plausível como causa de "Login inválido".

**Evidência técnica:**
- login busca usuário por email no banco e retorna `401` para usuário inexistente/senha inválida,
- bootstrap só cria admin se `ADMIN_BOOTSTRAP_ENABLED=true`,
- seed padrão está desabilitado (`SEED_ON_BOOTSTRAP=false`).

Ou seja: se o banco do preview estiver vazio (ou sem usuário válido), o login falha com 401 e o frontend exibe "Login inválido".

---

## 4) Bootstrap admin não executando
**Status:** provável em ambiente real de preview atual.

**Evidência:** o workflow escreve `ADMIN_BOOTSTRAP_ENABLED=true` em `/var/www/preview/pr-<N>/.env`, porém não sobe/reinicia containers naquele diretório. Sem startup da API, o `ensureAdminBootstrap()` não roda.

---

## 5) Workflow preview incompleto
**Status:** confirmado.

O workflow atual:
- conecta via SSH,
- cria diretório e arquivo `.env` parcial,
- executa comandos de diagnóstico (`git --version`, `docker --version` etc.),
- **não** executa deploy de aplicação.

Este é o ponto que explica o comportamento intermitente entre indisponibilidade e login inválido.

---

## Validações operacionais recomendadas no servidor (read-only)
> Rodar no host de preview para um PR específico, dentro de `/var/www/preview/pr-<N>`.

### A. Containers
```bash
docker ps
```

```bash
docker compose ps
```

```bash
docker compose logs --tail=300 api
```

### B. Conectividade frontend → API
1. Confirmar URL de API embutida no frontend build:
```bash
docker compose exec -T web sh -lc 'grep -R "VITE_API_URL\|/api" /usr/share/nginx/html/assets | head'
```

2. Confirmar proxy interno `/api` no Nginx do web:
```bash
docker compose exec -T web cat /etc/nginx/conf.d/default.conf
```

3. Testar login direto na API interna:
```bash
docker compose exec -T web sh -lc 'apk add --no-cache curl >/dev/null 2>&1 || true; curl -i http://api:4000/health'
```

### C. Banco usado no preview
1. Ver `DATABASE_URL` (sem expor senha):
```bash
docker compose exec -T api node -e 'const u=process.env.DATABASE_URL||"";const m=u.match(/postgres(?:ql)?:\/\/([^@]+@)?([^:/?#]+)(?::(\d+))?\/([^?]+)/i);console.log({hasDatabaseUrl:Boolean(u),host:m?.[2]??null,port:m?.[3]??null,database:m?.[4]??null});'
```

2. Confirmar isolamento preview vs produção:
- Se host/db apontarem para o mesmo alvo da produção, o preview **não está isolado**.
- O esperado é host/db próprios de preview (ou namespace dedicado por PR).

### D. Existência de usuários
```bash
docker compose exec -T db psql -U postgres -d salesforce_pro -c 'SELECT count(*) FROM "User";'
```

Opcional via Prisma:
```bash
docker compose exec -T api npx prisma studio
```

### E. Bootstrap admin
1. Confirmar flag ativa no container API:
```bash
docker compose exec -T api sh -lc 'echo "$ADMIN_BOOTSTRAP_ENABLED"'
```

2. Confirmar execução no startup (logs):
```bash
docker compose logs --tail=300 api | grep -E "Admin bootstrap|preview criado|ignorado"
```

### F. Erro real no login
Capturar status HTTP e payload:
```bash
curl -i -X POST "https://pr-<N>-crm.demetraagronegocios.com.br/api/auth/login" \
  -H 'Content-Type: application/json' \
  --data '{"email":"admin@preview.com","password":"123456"}'
```

Interpretar retorno:
- `401` → usuário inexistente ou senha inválida (problema de dados/credenciais)
- `5xx`/timeout → indisponibilidade de API/infra
- erro de conexão (`connection refused`, `502/503`) → WEB sem API acessível

---

## Evidências técnicas objetivas no repositório

1. O preview workflow não contém `git clone/pull`, `checkout` da branch do PR, nem `docker compose up -d`.
2. O Nginx de preview retorna página "Preview indisponível" quando a porta do PR não responde.
3. O web faz proxy `/api` para `api:4000`.
4. A API aceita `/auth/login` e `/api/auth/login`.
5. O login retorna `401` para credenciais inválidas/usuário ausente.
6. O bootstrap admin só executa com `ADMIN_BOOTSTRAP_ENABLED=true` durante startup da API.

---

## Conclusão final

Os dois sintomas têm a mesma origem operacional:
- **"Servidor indisponível"**: ambiente do PR não foi de fato provisionado/sobe incompleto.
- **"Login inválido"**: quando existe alguma instância acessível, ela pode estar sem usuário válido no banco (especialmente sem bootstrap efetivo).

Portanto, a causa raiz é **workflow de preview incompleto (infra)**, com consequência secundária de **estado de dados inconsistente**.
