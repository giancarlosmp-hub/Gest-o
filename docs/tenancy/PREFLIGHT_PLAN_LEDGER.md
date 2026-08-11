# Registry de evidência e ledger de plano — prova PostgreSQL

## Fronteira e inventário

A 1.0B.2-N substitui, **somente no banco descartável da prova**, o `Map` em memória de M e o
ledger/lock sintético de B por três objetos candidatos: registry de evidência, ledger de plano e
eventos técnicos. B já tinha hashes, batches, quarentena e lifecycle de desenvolvimento; M ligou
`evidenceId → evidenceHash → planHash`, mas o processo ainda não tinha coordenação distribuída.
Restart perdia o registry, dois processos podiam correr, e arquivo/lock local não protegia outros
hosts. Crash, replay conflitante e retomada eram portanto riscos produtivos pendentes.

## Modelo, lifecycle e dados permitidos

`tenant_preflight_evidence_registry` preserva ID/hash SHA-256, versões, geração, expiração, resultado
READY/BLOCKED e criação. `tenant_backfill_plan_ledger` preserva ID/hash único, FK composta à
evidência, versão, tenant técnico e somente `PLANNED`, `dry_run_only=true`,
`apply_authorized=false`. `tenant_backfill_plan_event` contém apenas tipo, IDs técnicos e timestamp.
Não guarda nomes, e-mails, documentos, tokens, credenciais, conexão, chaves/payload empresarial,
relatório ou plano completos.

As funções `SECURITY DEFINER`, com `search_path` fixo, são o único write path concedido ao papel
`preflight_plan_ledger_writer`. Insert e evento ocorrem na mesma transação. Replay byte-semanticamente
igual retorna `IDEMPOTENT_REPLAY`; troca de identidade/hash fecha com `23505`; FK ausente usa
`23503`; evidência BLOCKED/expirada ou flags inseguras usam `23514`. PK, unique, FK, checks e
advisory transaction locks namespaced por identidade serializam concorrentes sem binding parcial.

O papel normal recebe somente `SELECT` e `EXECUTE`, nunca DML direto. Triggers adicionais rejeitam
UPDATE/DELETE com `55000` inclusive se um papel futuro receber DML por engano; a prova negativa do
writer observa `42501` nos grants. Eventos `EVIDENCE_REGISTERED`, `PLAN_REGISTERED` e
`IDEMPOTENT_REPLAY` são transacionais. `CONFLICT_REJECTED` integra o contrato de auditoria futuro,
mas não é persistido pela transação que lança erro: PostgreSQL reverte também o evento; um
registrador autônomo não foi simulado para evitar falsa atomicidade.

## Concorrência, crash e retomada

O harness abre backends simultâneos, aguarda cada PID e captura exit code individual. Prova um
registro canônico para replays idênticos, um vencedor para hashes concorrentes (`23505` no perdedor),
planos idempotentes e conflito fechado de identidade. Rollback antes de COMMIT remove evidence,
plan e event conjuntamente. Reapresentação confirmada não altera hash nem `created_at`; plano exige
evidência confirmada e writer não consegue criar evento órfão.

## Harness, riscos e rollback

A prova usa `postgres:16`, rede Docker interna sem porta, recusa URLs herdadas, `docker exec -i`,
`psql -X`, `ON_ERROR_STOP`, schema `public`, arquivos mode 600, catálogo completo e baseline/diff.
O teardown é primeiro executado e revertido para provar rollback integral; depois é confirmado e o
catálogo deve voltar exatamente ao baseline. Não há `IF EXISTS`, skip ou fallback no caminho crítico.

## Evidência e aprendizados

No head remoto `029fab54d32413d0e94308227c0ae591144b7ee7`, Preview Deploy 31432019343 e Docker
Compose CI 31432019733/job 93597451158 passaram, inclusive os steps PostgreSQL de expand,
planejamento condicionado e ledger. `READY_FOR_1_0B_2_N_REVIEW = YES` e
`PREFLIGHT_PLAN_LEDGER_POSTGRES = PASS` descrevem exclusivamente essa prova descartável.

Readiness usa conexão SQL real ao database exato, não `pg_isready`. Replay concorrente usa locks
transacionais namespaced e ordem determinística porque `ON CONFLICT` parcial não cobre constraints
sobrepostas. Catálogo consulta `pg_catalog.pg_roles`; grants consultam
`information_schema.table_privileges` sobre três tabelas literais. Cada cenário registra PIDs,
waits, exits e streams separados; hashes não são reutilizados, com `p3` exclusivo do crash. O
teardown transacional, o teardown real e o baseline final impedem objetos residuais.

Isto não mede volume, contenção/WAL, pool, timeout, HA, restore ou permissões produtivas. O DDL não é
migration Prisma, não deve ser aplicado fora do container e não autoriza backfill/apply. Migration,
adapter produtivo, papel operacional e política de retenção exigem Sprint/autorização próprias.

- `READY_FOR_LEDGER_PRODUCTION_MIGRATION = NO`
- `READY_FOR_1_0B_2_N_REVIEW = YES`
- `PREFLIGHT_PLAN_LEDGER_POSTGRES = PASS`
- `READY_FOR_BACKFILL_PLANNING = YES` somente para planos sintéticos/dry-run
- `READY_FOR_BACKFILL_PRODUCTION = NO`
- `READY_FOR_TENANT_AWARE_RUNTIME = NO`
- `READY_FOR_MULTI_TENANT_CUTOVER = NO`
- `TENANCY_MODE_PRODUCTION = disabled`
- `TENANT_READ_PILOT_ENABLED_PRODUCTION = false`
- `PRODUCTION_ACCESSED = NO`
