# CLAUDE.md

Instruções para agentes que trabalham neste repositório. Não duplica a documentação: a visão
geral está no [`README.md`](README.md) e o estado oficial, decisões e procedimentos no
[`docs/DOCUMENTO_MESTRE.md`](docs/DOCUMENTO_MESTRE.md).

## Stack

- Monorepo npm workspaces (Node 20+, npm 10+).
- `apps/web`: React, Vite, TypeScript, Tailwind.
- `apps/api`: Node.js, Express, Prisma, PostgreSQL, JWT, Zod.
- `packages/shared`: schemas Zod e tipos compartilhados.
- Produção: Docker Compose numa VPS, implantada só pelo GitHub Actions **Deploy Production** em
  duas fases (`phase=build`, depois `phase=cutover`). Procedimento em
  [`docs/DEPLOY_GUIDE.md`](docs/DEPLOY_GUIDE.md) e na seção “Como implantar o Gest-o em produção”
  do Documento Mestre. Estado recente em [`docs/STATUS_ATUAL.md`](docs/STATUS_ATUAL.md); pendências
  em [`docs/TECH_DEBT.md`](docs/TECH_DEBT.md).

## Comandos

- `npm run build` e `npm run typecheck`: shared, API e web.
- `npm run test:architecture-docs`: gate de segurança da documentação.
- `npm run test:production-deploy`: scripts de deploy com Docker falso (roda no CI). Os testes em
  shell verificam dono e permissões de arquivo no padrão Linux e são suportados só em Linux/WSL e no
  CI. No Windows nativo passam 4 de 12 (`id -gn` falha, `stat -c '%U:%G'` devolve `UNKNOWN` e
  `chmod` falha na pasta temporária). A referência é o CI.
- Os demais `npm run test:*` estão em [`package.json`](package.json). Os sufixos `:postgres` e
  `:docker` exigem PostgreSQL ou Docker reais locais.

## Como trabalhar

- Pense antes de codar: diga as suposições e pergunte quando houver ambiguidade.
- Faça o mínimo necessário, sem recursos especulativos.
- Faça mudanças cirúrgicas: altere só o que foi pedido, mantenha o estilo existente e aponte (sem
  remover) código morto que encontrar.
- Defina antes como verificar o resultado (teste, build, preview).

## Regras do projeto

- Uma mudança por vez.
- Toda mudança vai por branch própria e Pull Request para `main`.
- Nada em produção (workflows produtivos, VPS, banco) sem aprovação explícita do Giancarlos.
- Nunca usar `--force` e nunca fazer push direto na `main`.
- Nunca colocar hostnames, IPs, senhas, tokens ou dados reais de clientes em arquivos, commits,
  PRs ou logs.
- Se algum comando for recusado, pare e pergunte antes de tentar de novo ou contornar.
