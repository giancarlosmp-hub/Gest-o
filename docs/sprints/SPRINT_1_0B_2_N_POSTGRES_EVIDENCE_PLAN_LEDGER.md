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

## Evidência verde da PR #796

O head remoto comprovado `029fab54d32413d0e94308227c0ae591144b7ee7` passou no GitHub Actions:

- Preview Deploy, run 31432019343: **PASS**;
- Docker Compose CI, run 31432019733, job `compose-smoke` 93597451158: **PASS**;
- `Prove tenancy roots expand on PostgreSQL 16`: **PASS**;
- `Prove preflight-gated backfill planning on PostgreSQL 16`: **PASS**;
- `Prove preflight evidence and plan ledger on PostgreSQL 16`: **PASS**;
- builds shared/web/API, typecheck, API health e smokes gerais: **PASS**.

Os steps verdes certificam a prova descartável. Não se inferem marcadores internos além dos
preservados pela evidência do step, nem estado de produção a partir do GitHub Actions.

## Lições duráveis

Readiness exige sessão SQL real no database exato (`psql -X`, `ON_ERROR_STOP=1`, `SELECT 1`, exit e
stdout exatos); `pg_isready` isolado não é autoridade. Constraints sobrepostas exigiram advisory
transaction locks namespaced por `evidence_id` e `plan_id`, com ordem fixa: replay idêntico retorna
`IDEMPOTENT_REPLAY` e divergência fecha em `23505`. Papel/grants são provados por
`pg_catalog.pg_roles`/`information_schema.table_privileges` e inventário literal, não `LIKE`.
Concorrência preserva PIDs, waits, exits e streams separados. Fixtures não se sobrepõem (`p3` é
exclusivo de crash/rollback), e rollback do teardown precede teardown real e baseline final idêntico.

## Declarações

- `READY_TO_MERGE_PR_796 = NO` até o commit documental repetir os checks obrigatórios
- `READY_FOR_1_0B_2_N_REVIEW = YES`
- `PREFLIGHT_PLAN_LEDGER_POSTGRES = PASS`
- `READY_FOR_LEDGER_PRODUCTION_MIGRATION = NO`
- `READY_FOR_BACKFILL_PLANNING = YES` somente para planos sintéticos/dry-run
- `READY_FOR_BACKFILL_PRODUCTION = NO`
- `READY_FOR_TENANT_AWARE_RUNTIME = NO`
- `READY_FOR_MULTI_TENANT_CUTOVER = NO`
- `TENANCY_MODE_PRODUCTION = disabled`
- `TENANT_READ_PILOT_ENABLED_PRODUCTION = false`
- `PRODUCTION_ACCESSED = NO`
