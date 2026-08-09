# Sprint 1.0B.2-M — Preflight-Gated Backfill Planning Contract

## Baseline e escopo

O HEAD inicial `bdaf2e2` é o merge commit local da PR #794, comprovando que a baseline contém o merge aprovado; o checkout gerenciado não possui origin/gh configurado. A entrega integra o preflight L ao tooling B exclusivamente para gerar planos determinísticos. Não houve acesso à produção, preflight produtivo, backfill, DML, ledger produtivo, migration, NOT NULL, RLS, endpoint, runtime, deploy ou cutover.

O envelope é estrito, versionado, temporal e hash-bound. Relatório `BLOCKED_EXPECTED` não produz plano/batch/fallback. Fixture READY sintética cobre os 11 roots e gera o mesmo plano sob repetição ou reordenação. Negativas cobrem adulteração, identidade, expiração, versões, inventário, blocker/quarentena ocultos, totais, control plane, apply, campos desconhecidos e ausência de registry compartilhado.

## Segurança e operação

READY somente autoriza **gerar um plano dry-run**, nunca apply. `evidenceHash` e `planHash` são inseparáveis; troca/replay conflitante bloqueia. Blockers/quarentena impedem qualquer plano. Evidência sintética não representa produção. Rollback é retirar os artefatos aditivos; auditoria futura preserva hashes/códigos técnicos, sem dados empresariais. Autoridade produtiva, registry/ledger distribuído, performance, expiração operacional e execução formal continuam pendentes.

## Declarações

`READY_FOR_1_0B_2_M_REVIEW = NO` até checks reais verdes  
`PREFLIGHT_GATED_BACKFILL_PLAN = NOT_PROVEN`  
`READY_FOR_BACKFILL_PLANNING = NO` até gate real verde  
`READY_FOR_BACKFILL_PRODUCTION = NO`  
`READY_FOR_TENANT_AWARE_RUNTIME = NO`  
`READY_FOR_MULTI_TENANT_CUTOVER = NO`  
`TENANCY_MODE_PRODUCTION = disabled`  
`TENANT_READ_PILOT_ENABLED_PRODUCTION = false`  
`PRODUCTION_ACCESSED = NO`
