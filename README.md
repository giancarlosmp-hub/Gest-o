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
```bash
docker compose up --build
```
Acesse:
- Web: `http://localhost:5173`
- API: `http://localhost:4000`

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
- Seed: `npm run prisma:seed`

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
