# SalesForce Pro (Monorepo SaaS)

Monorepo completo com frontend React + Vite + TypeScript e backend Node.js + Express + Prisma/PostgreSQL.

## Stack
- **Web**: React, Vite, TypeScript, Tailwind, chart.js, react-chartjs-2, React Router, sonner
- **API**: Node.js, TypeScript, Express, Prisma, PostgreSQL, JWT (access + refresh), Zod, bcrypt, helmet, cors, rate-limit, morgan
- **Monorepo**: npm workspaces

## Estrutura
- `apps/web` frontend SPA com sidebar, topbar, dashboard e CRUDs
- `apps/api` backend REST com auth, RBAC e dashboard
- `packages/shared` schemas Zod e tipos compartilhados

## Requisitos
- Node 20+
- npm 10+
- Docker e Docker Compose (opcional, recomendado)

## Rodar com Docker Compose

## Deploy normal (preserva dados)
```bash
bash deploy.sh
```

## Reset total (apaga tudo)
> **Somente ambiente de desenvolvimento/testes. Nunca use em produção.**
```bash
bash deploy-reset.sh
```

> O startup da API aplica apenas `prisma db push`. O seed padrão **não** roda automaticamente no compose para preservar dados já existentes.

Valide os serviços:
```bash
docker compose ps
curl http://localhost:4000/health
```
Acesse:
- Web: `http://localhost:5173`
- API: `http://localhost:4000`

### Variáveis de produção (VPS)
No ambiente de produção, defina no `.env` (ou no provedor de deploy):
```bash
NODE_ENV=production
FRONTEND_URL=https://crm.seudominio.com
CORS_ALLOWED_ORIGINS=https://crm.seudominio.com
VITE_API_URL=/api
JWT_ACCESS_SECRET=<segredo-forte>
JWT_REFRESH_SECRET=<segredo-forte-diferente>
```
- `VITE_API_URL` é injetada no build do frontend Docker.
- Sem `VITE_API_URL`, o frontend usa `/api` em produção e `http://localhost:4000` apenas em desenvolvimento (`npm run dev`).
- Em produção, mantenha o proxy reverso do Nginx para `location /api/` -> `http://127.0.0.1:4000/`.
- No `docker compose`, os healthchecks usam endpoints reais: API em `/health` (HTTP 200) e Web em `/healthz` servido pelo Nginx (sem dependência do backend).
- O serviço `web` depende de `api` com `condition: service_started` para não bloquear a stack por falso `unhealthy` quando apenas o healthcheck do backend oscilar.

### Publicar CRM com Nginx no VPS
Para configurar o domínio `crm.demetraagronegocios.com.br` com proxy para o frontend em `127.0.0.1:5173` e API em `127.0.0.1:4000` via `/api`, execute:

```bash
bash scripts/setup-nginx-crm.sh
bash scripts/setup-ssl-crm.sh
```

### Validação no Windows (CMD)
```cmd
docker compose down
docker compose up -d
docker compose ps
curl http://localhost:4000/health
curl -X POST http://localhost:4000/auth/login -H "Content-Type: application/json" -d "{\"email\":\"diretor@empresa.com\",\"password\":\"123456\"}"
```
Esperado:
- `bash deploy.sh` finaliza sem erro.
- `curl http://localhost:4000/health` retorna HTTP 200.
- Login retorna HTTP 200 com usuário `diretor@empresa.com`.


## Deploy em Produção
Sempre usar: `bash deploy.sh`

### ⚠️ Atenção — Segurança de Dados
NUNCA execute:

```bash
docker compose down -v
```

Esse comando remove os volumes Docker e APAGA completamente o banco de dados.

Use sempre:

```bash
docker compose down
docker compose up -d
```

ou:

```bash
bash deploy.sh
```


## Segurança de Dados em Produção
- A API executa uma verificação de sanidade (`checkDatabaseHealth`) antes de subir em `NODE_ENV=production`.
- Em produção, banco inconsistente é bloqueado com erro crítico e a inicialização é abortada (`fail-safe`).
- Em produção, `SEED_ON_BOOTSTRAP`, `ENABLE_SMOKE_BOOTSTRAP` e `ADMIN_BOOTSTRAP_ENABLED` são sempre ignorados, mesmo que estejam `true`.
- O `deploy.sh` captura snapshot antes/depois do deploy para `User`, `Client`, `Opportunity` e `TimelineEvent` e aborta automaticamente se detectar risco de perda.
- O `backup.sh` valida o conteúdo do banco após o `pg_dump` e descarta dump inconsistente (arquivo removido).
- O volume do PostgreSQL é fixo (`gest-o_pgdata`) para evitar alternância acidental de volume.


## Trava de segurança do deploy
O `deploy.sh` agora inclui uma validação defensiva de integridade de dados para evitar que uma atualização finalize com banco vazio/inconsistente.

Fluxo aplicado automaticamente:
1. executa o backup antes do deploy (comportamento preservado);
2. coleta snapshot de contagem das tabelas críticas antes de subir os novos containers:
   - `User`
   - `Client`
   - `Opportunity`
   - `TimelineEvent`
3. registra essas contagens em log (`logs/deploy-YYYYMMDD-HHMMSS.log`);
4. sobe os containers, valida healthcheck e coleta novo snapshot;
5. aplica trava de segurança e aborta com erro (`exit 1`) se detectar:
   - `User` zerada em qualquer cenário;
   - `Client` zerada após ter dados antes;
   - `Opportunity` zerada após ter dados antes;
   - `TimelineEvent` zerada após ter dados antes;
   - múltiplas tabelas críticas zeradas ao mesmo tempo.

Quando a trava aciona, o deploy **não** é marcado como concluído e o motivo fica explícito no log.

## Variáveis obrigatórias no .env
```bash
FRONTEND_URL=https://crm.demetraagronegocios.com.br
CORS_ALLOWED_ORIGINS=https://crm.demetraagronegocios.com.br
VITE_API_URL=https://crm.demetraagronegocios.com.br/api
```

## Rodar local (sem Docker)
1. Suba um PostgreSQL local.
2. Copie `.env.example` para `.env` e ajuste `DATABASE_URL`.
3. Instale dependências:
```bash
npm install
```
4. Gere client e migrações + seed:
```bash
npm run prisma:migrate
npm run prisma:seed
```
5. Rode API e Web em paralelo:
```bash
npm run dev
```

## Prisma
- Gerar client: `npm run prisma:generate -w @salesforce-pro/api`
- Migrate: `npm run prisma:migrate`
- Seed manual: `npm run prisma:seed`

### Seed no bootstrap (opcional para desenvolvimento)
Por padrão, o seed automático está desligado (`SEED_ON_BOOTSTRAP=false`).
Para forçar seed no startup da API em ambiente de dev, defina:
```bash
SEED_ON_BOOTSTRAP=true
```


### Bootstrap administrativo opcional (produção)
Para garantir automaticamente um usuário diretor inicial no startup da API (modo idempotente), configure:

```bash
ADMIN_BOOTSTRAP_ENABLED=true
ADMIN_BOOTSTRAP_NAME="Diretor Produção"
ADMIN_BOOTSTRAP_EMAIL="diretor@seudominio.com"
ADMIN_BOOTSTRAP_PASSWORD="TroqueAgora#2026"
ADMIN_BOOTSTRAP_ROLE="diretor"
ADMIN_BOOTSTRAP_REGION="Nacional"
```

Comportamento:
- `ADMIN_BOOTSTRAP_ENABLED=false` (ou ausente): não faz nada;
- `true`: busca por e-mail; cria se não existir; atualiza `name`, `passwordHash`, `role`, `region` e `isActive=true` se já existir;
- não cria usuário duplicado.

### Bootstrap mínimo para compose-smoke
O compose padrão habilita `ENABLE_SMOKE_BOOTSTRAP=true` para garantir um usuário técnico de login e um vendedor/cliente mínimos do smoke test de forma **idempotente** (sem `deleteMany`).
Isso não executa o seed destrutivo e não reseta dados reais.

### Backfill de normalizados de clientes
Para preencher `cnpjNormalized`, `nameNormalized` e `cityNormalized` em registros já existentes:
```bash
docker compose exec api npm run clients:backfill-normalized -w @salesforce-pro/api
```

### Garantir usuário administrativo (diretor) via CLI
Para criar/atualizar um usuário administrativo de forma idempotente (sem insert manual no banco), execute:

```bash
docker compose exec api npm run admin:ensure-user -w @salesforce-pro/api -- --name="Admin" --email="admin@demetra.local" --password="Admin123!" --role="diretor" --region="Nacional"
```

Comportamento do comando:
- se o e-mail não existir, cria o usuário com `isActive=true`;
- se já existir, atualiza `name`, `role`, `region`, `isActive=true` e a senha (com o mesmo hash do login);
- valida roles permitidas (`diretor`, `gerente`, `vendedor`);
- não exibe senha em texto puro nos logs.

Exemplo de uso no VPS (produção):

```bash
docker compose -f /opt/demetra/docker-compose.yml exec api npm run admin:ensure-user -w @salesforce-pro/api -- --name="Diretor Produção" --email="diretor@seudominio.com" --password="TroqueAgora#2026" --role="diretor" --region="Nacional"
```

## Usuários seed
- diretor@empresa.com / 123456 (diretor)
- gerente@empresa.com / 123456 (gerente)
- vendedor1@empresa.com / 123456 (vendedor)
- vendedor2@empresa.com / 123456 (vendedor)
- vendedor3@empresa.com / 123456 (vendedor)
- vendedor4@empresa.com / 123456 (vendedor)

## Checklist de teste manual
1. Login:
   - Acessar `/login`, autenticar com diretor@empresa.com/123456.
2. Dashboard:
   - Ver KPIs, gráfico de linha, doughnut, ranking e atividades recentes.
3. CRUD Clientes:
   - Criar cliente, editar e excluir.
4. CRUD Oportunidades:
   - Criar oportunidade com estágio e editar estágio.
5. CRUD Atividades:
   - Criar atividade e marcar done pelo endpoint patch.
6. Metas:
   - Diretor/Gerente criam metas; vendedor somente visualiza.
7. RBAC:
   - Login com vendedor e validar ocultação de Usuários/Configurações.

## Testes rápidos da API de oportunidades
> Use um token JWT válido no header `Authorization: Bearer <token>`.

```bash
# Listar oportunidades (com client, owner, daysOverdue e weightedValue)
curl "http://localhost:4000/opportunities" \\
  -H "Authorization: Bearer <token>"

# Filtrar por stage
curl "http://localhost:4000/opportunities?stage=negociacao" \\
  -H "Authorization: Bearer <token>"

# Filtrar apenas atrasadas (expectedReturnDate/expectedCloseDate < hoje e sem ganho/perdido)
curl "http://localhost:4000/opportunities?overdue=true" \\
  -H "Authorization: Bearer <token>"

# Resumo do pipeline
curl "http://localhost:4000/opportunities/summary" \\
  -H "Authorization: Bearer <token>"
```
