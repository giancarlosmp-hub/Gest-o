# Sprint 1.0B.2-L — Tenant Data Readiness Preflight

## Baseline e objetivo

O histórico local comprova que o HEAD inicial `1b467315268c4c2a66bef711594949a32f778665` é o merge commit da PR #793. O checkout não possui origin/main/gh e o acesso remoto foi impedido pelo ambiente; portanto a equivalência é comprovada pelo próprio merge local, sem inferir checks remotos.

A Sprint entrega somente o contrato read-only sanitizado para diagnosticar control plane e os 11 roots antes de um eventual planejamento de backfill. Não acessa produção, executa backfill/DML/migration, muda resposta legada, cria endpoint, ativa runtime, RLS, NOT NULL ou cutover.

## Entregáveis e aceite

- módulo com reader injetável, snapshots mínimos e SHA-256 determinístico;
- inventário fechado, contagens e blockers fail-closed;
- testes de leitura parcial, root ausente/inesperado, hash adulterado, membership ambígua, tenant suspenso, cross-tenant, ownership NULL e concorrência isolada;
- harness descartável `postgres:16`, rede interna sem porta, transação read-only e hash antes/depois;
- gate CI depois do preview tenancy e antes dos smokes gerais.

`READY` significa apenas que o dataset observado está pronto para **planejamento**. Não é autorização para executar nem alegação produtiva. NULL é pendência e permanece intacto; inconsistências permanecem intactas e são bloqueadas/quarentenáveis. Rollback remove apenas o código aditivo e o gate.

## Declarações

`READY_TO_MERGE_PR_794 = NO` até novo GitHub Actions verde
`READY_FOR_1_0B_2_L_REVIEW = NO` até checks reais verdes  
`TENANT_DATA_READINESS_PREFLIGHT = NOT_PROVEN`  
`READY_FOR_BACKFILL_PLANNING = NO` até preflight verde  
`READY_FOR_BACKFILL_PRODUCTION = NO`  
`READY_FOR_TENANT_AWARE_RUNTIME = NO`  
`READY_FOR_MULTI_TENANT_CUTOVER = NO`  
`TENANCY_MODE_PRODUCTION = disabled`  
`TENANT_READ_PILOT_ENABLED_PRODUCTION = false`  
`PRODUCTION_ACCESSED = NO`
