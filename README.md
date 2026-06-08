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
```bash
bash deploy-reset.sh
```

> O startup da API aplica apenas `prisma db push`. O seed padrão **não** roda automaticamente no compose para preservar dados já existentes.

> Após aplicar esta mudança no servidor, **não** use `docker compose down -v`. Preserve o volume do PostgreSQL `gest-o_pgdata` e utilize apenas `bash deploy.sh` ou `docker compose down && docker compose up -d`.

Valide os serviços:
```bash
docker compose ps
curl http://localhost:4000/health
```
Acesse:
- Web: `http://localhost:5173`
- API: `http://localhost:4000`

### Variáveis de produção (VPS)
No ambiente de produção, mantenha segredos sensíveis fora do repositório em `/root/demetra-env/.env` (veja `docs/erp-production-env-setup.md`). Variáveis não sensíveis ainda podem ser exportadas pelo shell, workflow ou arquivo local usado apenas para interpolação do Compose:
```bash
NODE_ENV=production
FRONTEND_URL=https://crm.seudominio.com
CORS_ALLOWED_ORIGINS=https://crm.seudominio.com
VITE_API_URL=/api
JWT_ACCESS_SECRET=<segredo-forte>
JWT_REFRESH_SECRET=<segredo-forte-diferente>
```
- `VITE_API_URL` é injetada no build do frontend Docker.
- A consulta de CNPJ deve ser habilitada somente no backend; suporte nativo a `CNPJ_LOOKUP_PROVIDER=brasilapi` (sem chave) ou `CNPJ_LOOKUP_PROVIDER=generic` com `CNPJ_LOOKUP_BASE_URL` e, se necessário, `CNPJ_LOOKUP_API_KEY`. Não exponha essa credencial no frontend.
- O `docker-compose.yml` já repassa `CNPJ_LOOKUP_PROVIDER`, `CNPJ_LOOKUP_BASE_URL` e `CNPJ_LOOKUP_API_KEY` para o serviço `api` usando variáveis do `.env` com fallback seguro para BrasilAPI; o `deploy.sh` agora valida a configuração resolvida antes do rebuild para evitar subir a API sem o provider esperado.
- Sem `VITE_API_URL`, o frontend usa `/api` em produção e `http://localhost:4000` apenas em desenvolvimento (`npm run dev`).
- Em produção, mantenha o proxy reverso do Nginx para `location /api/` -> `http://127.0.0.1:4000/`.
- No `docker compose`, os healthchecks usam endpoints reais: API em `/health` (HTTP 200) e Web em `/healthz` servido pelo Nginx (sem dependência do backend).
- O serviço `web` depende de `api` com `condition: service_started` para não bloquear a stack por falso `unhealthy` quando apenas o healthcheck do backend oscilar.
- O PostgreSQL deve permanecer acessível apenas internamente na rede do Docker; para administração, use `docker compose exec db psql -U postgres -d salesforce_pro` ou um túnel SSH controlado. Veja `docs/ops/postgresql-access.md`.

### Publicar CRM com Nginx no VPS
Para configurar o domínio `crm.demetraagronegocios.com.br` com proxy para o frontend em `127.0.0.1:5173` e API em `127.0.0.1:4000` via `/api`, execute:

```bash
bash scripts/setup-nginx-crm.sh
bash scripts/setup-ssl-crm.sh
```

### Validação no Windows (CMD)
```cmd
REM apenas em ambiente local descartável, nunca em produção
docker compose down
bash deploy.sh
docker compose ps
curl http://localhost:4000/health
curl -X POST http://localhost:4000/auth/login -H "Content-Type: application/json" -d "{\"email\":\"diretor@empresa.com\",\"password\":\"123456\"}"
```
Esperado:
- `bash deploy.sh` finaliza sem erro.
- `curl http://localhost:4000/health` retorna HTTP 200.
- Login retorna HTTP 200 com usuário `diretor@empresa.com`.

### Consulta de CNPJ no backend
A busca automática por CNPJ do frontend chama apenas o backend (`GET /clients/cnpj-lookup/:cnpj`). A configuração deve ficar **somente** na API.

Variáveis suportadas:
- `CNPJ_LOOKUP_PROVIDER`
  - `brasilapi`: usa `https://brasilapi.com.br/api/cnpj/v1` por padrão no `docker-compose` e **não** exige chave.
  - `generic`: exige `CNPJ_LOOKUP_BASE_URL`; a URL pode conter `{cnpj}` (ex.: `https://api.exemplo.com/v1/cnpj/{cnpj}`) ou, se não contiver placeholder, a API anexará `/<cnpj>` automaticamente.
- `CNPJ_LOOKUP_BASE_URL`
  - obrigatório para `generic`;
  - opcional para `brasilapi` no código;
  - no `docker-compose`, o fallback padrão já define `https://brasilapi.com.br/api/cnpj/v1`.
- `CNPJ_LOOKUP_API_KEY`
  - opcional;
  - use apenas quando o provedor exigir autenticação.

Como habilitar no ambiente com Docker Compose/VPS:
```bash
# opção 1: usar o padrão do projeto com BrasilAPI
# basta manter ou definir no .env da stack:
CNPJ_LOOKUP_PROVIDER=brasilapi
CNPJ_LOOKUP_BASE_URL=https://brasilapi.com.br/api/cnpj/v1
CNPJ_LOOKUP_API_KEY=

# depois do ajuste no .env, publique sem apagar volumes nem resetar banco:
bash deploy.sh

# validação opcional da configuração aplicada ao serviço api
# (o deploy.sh também faz uma checagem automática antes do rebuild)
docker compose config | grep CNPJ_LOOKUP
```

Exemplo com provedor próprio/terceiro:
```bash
CNPJ_LOOKUP_PROVIDER=generic
CNPJ_LOOKUP_BASE_URL=https://api.seu-provedor.com/cnpj/{cnpj}
CNPJ_LOOKUP_API_KEY=seu-token-aqui
```

Checklist operacional para VPS:
- editar apenas o `.env` da stack/compose;
- confirmar `docker compose config | grep CNPJ_LOOKUP` antes do redeploy, se quiser validar manualmente;
- executar `bash deploy.sh` ou `docker compose down && docker compose up -d --build`;
- **não** usar `docker compose down -v`, `migrate reset` ou qualquer ação destrutiva no banco.

Mensagens de erro retornadas pelo backend agora distinguem:
- integração desabilitada;
- configuração inválida/incompleta;
- CNPJ inválido;
- empresa não encontrada;
- indisponibilidade temporária do provedor.


## Deploy em Produção
Sempre usar: `bash deploy.sh`
Para reset completo quando necessário: `bash deploy-reset.sh`

### Volume oficial do PostgreSQL em produção
- volume correto de produção: `gest-o_pgdata`;
- o `docker-compose.yml` referencia esse volume explicitamente via `volumes.postgres_data.name`;
- **nunca** alternar produção para `pgdata`;
- **nunca** recriar/trocar o volume como forma de "corrigir" deploy.

## ⚠️ Segurança rígida de produção

Em ambiente de produção, **nunca** execute:

```bash
docker compose down -v
```

Motivo:
- esse comando remove os volumes Docker;
- ao remover os volumes, o banco de dados pode ser apagado;
- em produção, o volume oficial do PostgreSQL é `gest-o_pgdata`;
- a blindagem do projeto assume preservação total do volume do PostgreSQL.

Use apenas os comandos corretos para reiniciar ou publicar o sistema com segurança:

```bash
docker compose down
docker compose up -d
```

ou:

```bash
bash deploy.sh
```

Proteções rígidas aplicadas em produção:
- o `deploy.sh` tira snapshot antes e depois do rebuild, aguarda healthcheck real da API e aborta se detectar perda de dados;
- a API valida as contagens críticas no startup e **não sobe** normalmente se o banco estiver inconsistente;
- o `backup.sh` rejeita backup inconsistente e não aceita dump vazio como backup válido;
- o script `scripts/check-prod-health.sh` faz pré-checagem manual em modo somente leitura;
- seed automático segue desabilitado em produção por padrão.
- o PostgreSQL não deve ter a porta `5432` exposta publicamente; o acesso administrativo deve ser feito por `docker compose exec` no container `db` ou via túnel SSH controlado.

## Trava rígida do deploy
O `deploy.sh` executa o seguinte fluxo defensivo:

1. executa o backup antes do deploy;
2. coleta snapshot das tabelas críticas antes de derrubar os containers:
   - `User`
   - `Client`
   - `Opportunity`
   - `TimelineEvent`
   - `AgendaEvent`
   - `Activity`
3. registra as contagens em log (`logs/deploy-YYYYMMDD-HHMMSS.log`);
4. sobe os containers novamente, aguarda healthcheck real da API e coleta o snapshot pós-start;
5. bloqueia o deploy com log obrigatório `[CRITICAL] DEPLOY BLOQUEADO: perda de dados detectada` se detectar, por exemplo:
   - qualquer tabela crítica que tinha dados antes e foi para zero depois;
   - `Client` zerada;
   - `Opportunity` zerada quando antes era maior que zero;
   - `TimelineEvent` zerada quando antes era maior que zero;
   - múltiplas tabelas críticas zeradas ao mesmo tempo.

Quando a trava aciona, o deploy termina com `exit 1` e o sistema não considera a publicação como concluída.

## Trava rígida no startup da API
Na inicialização da API, em **produção real** (`NODE_ENV=production`, fora de smoke/CI), o backend consulta as tabelas críticas e aborta o processo com o log obrigatório `[CRITICAL] Banco inconsistente detectado — inicialização abortada` quando detectar qualquer um dos cenários abaixo:

- `User == 0`;
- `Client == 0`;
- `Client == 0` e `Opportunity == 0`;
- múltiplas tabelas críticas zeradas ao mesmo tempo.

Isso impede que a API fique saudável/publicável quando houver forte sinal de banco vazio ou inconsistente.

## Blindagem do backup
O `backup.sh` passou a validar o banco antes de aceitar o backup como válido. A verificação confere contagens de:

- `User`;
- `Client`;
- `Opportunity`;
- `TimelineEvent`.

Se o banco estiver inconsistente, o script registra `[CRITICAL] Backup rejeitado: banco inconsistente`, aborta e não mantém dump vazio/inválido como backup confiável.

## Pré-checagem manual (somente leitura)
Antes de um deploy ou auditoria operacional, execute:

```bash
bash scripts/check-prod-health.sh
```

Comportamento:
- consulta as contagens das tabelas críticas em modo somente leitura;
- imprime relatório legível no terminal;
- retorna `exit 1` se detectar banco inconsistente.

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

## Teste de preview automático
Esta alteração serve apenas para validar o deploy preview via GitHub Actions.
