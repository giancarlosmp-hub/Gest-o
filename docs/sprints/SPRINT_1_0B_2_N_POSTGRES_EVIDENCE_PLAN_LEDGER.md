# Sprint 1.0B.2-N — PostgreSQL Evidence Registry and Plan Ledger Proof

## Baseline e objetivo

O HEAD inicial `14dd96f` é o merge commit local da PR #795 e contém `e145625`, comprovando a main
aprovada no checkout gerenciado sem origin/gh. Esta Sprint prova em PostgreSQL 16 descartável um
registry/ledger concorrente e append-only para `evidenceId → evidenceHash → planHash`.

## Entrega e limites

O DDL candidato fica em `scripts/smoke/sql`, nunca em migrations Prisma. Funções transacionais,
constraints, locks de linha, grants e triggers provam idempotência, conflito por SQLSTATE, expiração,
BLOCKED, crash/rollback, retomada e mutações negativas. Contratos TypeScript são somente interfaces
injetáveis, sem Prisma singleton, conexão ou adapter. O CI posiciona a prova após o planejamento M e
antes dos smokes gerais.

Não houve migration produtiva, tabela/ledger em produção, backfill, DML empresarial, apply, acesso a
produção, runtime tenant-aware, RLS, NOT NULL, cutover ou deploy. Rollback remove apenas os artefatos
aditivos desta prova; no container o teardown retorna ao catálogo inicial.

## Declarações

- `READY_FOR_1_0B_2_N_REVIEW = NO` até checks reais verdes
- `PREFLIGHT_PLAN_LEDGER_POSTGRES = NOT_PROVEN`
- `READY_FOR_LEDGER_PRODUCTION_MIGRATION = NO`
- `READY_FOR_BACKFILL_PLANNING = YES` somente para planos sintéticos/dry-run
- `READY_FOR_BACKFILL_PRODUCTION = NO`
- `READY_FOR_TENANT_AWARE_RUNTIME = NO`
- `READY_FOR_MULTI_TENANT_CUTOVER = NO`
- `TENANCY_MODE_PRODUCTION = disabled`
- `TENANT_READ_PILOT_ENABLED_PRODUCTION = false`
- `PRODUCTION_ACCESSED = NO`
