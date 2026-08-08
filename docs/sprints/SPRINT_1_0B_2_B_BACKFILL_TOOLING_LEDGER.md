# Sprint 1.0B.2-B — tooling e ledger do backfill

**Estado encontrado (08/08/2026):** a branch nasceu do merge `4f933f7` da PR #783. A migration
`20260808120000_tenancy_expand_roots` e o Prisma contêm exatamente os 11 roots autorizados, com
`tenantId` nullable, FK `NO ACTION`, índice simples e uniques globais preservadas. Foram
inventariados preparação default-only, preview/apply do control plane, catálogos TSV, evidências
sanitizadas e harnesses PostgreSQL 16. Seus contratos fail-closed foram reutilizados, sem copiar ou
acionar scripts produtivos.

## Arquitetura e contrato

`backfillTooling.ts` é separado de bootstrap, migrations, seed, scheduler, HTTP e runtime. Expõe
plan/dry-run determinístico, autorização de apply exclusivamente sintético e reconciliação. Não há
comando de apply produtivo. O alvo é obrigatório, existente e ativo; tenant adicional bloqueia o
plano. Não há inferência por seller, filial, WhatsApp, conteúdo ou ERP.

Cada root registra total, NULL, correto, divergente, quarentena, limites de batch, SHA-256 de
`PK<TAB>tenant`, tenant alvo e versão/timestamp/estado. O hash agregado cobre a sequência ordenada
`root<TAB>rootHash`. PKs têm ordenação estável, cursor no último ID confirmado e batch padrão/limite
250/1000, sem OFFSET. Escrita futura exige `tenantId IS NULL`, lock exclusivo, timeout e abort entre
batches; nunca troca valor não nulo.

## Ledger e lifecycle

Foram comparados ledger PostgreSQL (transacional/lock distribuído, porém exige DDL e autoridade de
escrita) e evidência imutável em arquivo (padrão já usado, mínima e portável). Foi escolhida a
**evidência imutável**: o objeto canônico deve ser criado exclusivamente, com checksum/permissão
restrita, sem PII, payload, URL ou segredo. Risco: filesystem não oferece lock distribuído
produtivo. O harness demonstra exclusão por escopo apenas no PostgreSQL sintético descartável; isso
não cria nem autoriza ledger/lock produtivo. Essa decisão operacional permanece bloqueada para uma
fase futura, obrigatoriamente antes de qualquer backfill produtivo. Arquivo parcial ou estado
diferente de `reconciled` nunca é PASS.

Lifecycle: `planned → dry_run_passed → approved → applying → reconciled`; `aborted`, `failed` e
`quarantined` são terminais para a tentativa. Aprovação e apply sintético têm autoridades distintas.
Abort preserva cursor/evidência e interrompe antes do próximo batch, sem reversão automática.

## Quarentena, reconciliação, riscos e rollback

Referência inválida ou ownership divergente permanece intacto; registra-se apenas hash do ID e
reason code sanitizado. Quarentena/divergência bloqueia PASS. Reconciliação exige total preservado,
IDs únicos, zero exclusão/duplicação, tenant válido, nenhum cross-tenant, hash aprovado/aplicado
idêntico e quarentena zero ou registrada.

| Risco | Controle |
|---|---|
| alvo incorreto | alvo explícito/ativo e tenant inesperado bloqueiam |
| corrida/replay | lock futuro, cursor por PK, predicado NULL e hash aprovado |
| ambiguidade | quarentena sem mutação/payload |
| produção | caminho produtivo inexistente e autorização sintética fail-closed |
| evidência incompleta | somente `reconciled` pode ser PASS |

Rollback é abortar, preservar nullable/runtime/ledger e reconciliar; nunca `DROP`, `DELETE` ou troca
automática. A prova não mede volume, WAL, locks produtivos, SLO ou restore. Aceite exige os 11 roots,
dry-run read-only, batches/hash/quarentena/lifecycle, gates negativos e PostgreSQL 16 explícito no
CI. A sequência oficial preserva **1.0B.2-C para TenantContext/Auth compatibility**; ela não recebe
o objetivo de decidir ledger ou lock produtivo. Autoridade, ledger/lock distribuído, timeout,
performance e operação continuam bloqueados para decisão futura antes de qualquer backfill real.
Não houve VPS, produção, deploy, backfill real, segundo tenant funcional, RLS, NOT NULL, runtime ou
cutover.

`DATABASE_SCHEMA_MODE=external`; `TENANCY_MODE=disabled`;
`READY_FOR_MULTI_TENANT_CUTOVER=NO`; `READY_FOR_BACKFILL_PRODUCTION=NO`.
