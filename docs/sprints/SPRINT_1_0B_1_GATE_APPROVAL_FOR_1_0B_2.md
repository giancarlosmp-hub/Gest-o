# Sprint 1.0B.1-GATE-APPROVAL — abertura controlada da 1.0B.2

## Contexto

Este registro é exclusivamente documental. O executor forneceu explicitamente à tarefa, em
08/08/2026, `COMMITTEE_DECISION=APPROVE_1_0B_2_DEVELOPMENT`. A decisão é humana; o Codex apenas a
registra e não atua como Comitê. O predecessor autorizado é o merge commit da PR #781,
`04d4185b25416ac2cc4ecdaef36c5c0b3e9ef1bc`, informado como já confirmado externamente.

O checkout disponibilizado não contém `origin` nem branch `main`. Por isso, `origin/main`, o estado
remoto e os checks reais do merge não são verificáveis neste ambiente e não são inventados. Antes
da alteração, `HEAD` correspondia exatamente ao predecessor autorizado e a worktree estava limpa.

## Certificações predecessoras

- a Sprint 1.0A estabeleceu foundation, ADR, threat model, RACI e contratos suficientes para expand;
- a Sprint 1.0B.1 persistiu o control plane default-only;
- a OP-EXEC certificou migration aplicada, tenant default, 8 memberships reconciliadas e remoção
  das autoridades temporárias;
- a auditoria de readiness não encontrou bloqueador técnico adicional para iniciar expand e deixou
  como único bloqueador a aprovação humana agora fornecida;
- continuam vigentes `DATABASE_SCHEMA_MODE=external`, `TENANCY_MODE=disabled`, ausência de cutover,
  ausência de segundo tenant produtivo e ausência de multiempresa ativa.

## Matriz resumida

| Gate revalidado | Resultado | Condição preservada |
|---|---|---|
| 1.0A/foundation suficiente para expand | PASS | condições da ADR permanecem obrigatórias |
| Control plane persistence concluído | PASS | migration histórica não será alterada |
| OP-EXEC concluída | PASS | evidência operacional predecessora preservada |
| Tenant default reconciliado | PASS | `tenant-default-v1` e 8 memberships |
| Runtime continua disabled | PASS | sem integração produtiva antecipada |
| Expand usa `tenantId` nullable | PASS | sem `NOT NULL` nesta etapa |
| Expand sem backfill | PASS | DDL e backfill em entregas separadas |
| Uniques globais preservadas | PASS | remoção somente em fase específica futura |
| Nenhum segundo tenant produtivo | PASS | A×B somente sintético e descartável |
| RLS não habilitada nesta etapa | PASS | permanece gate anterior ao cutover |
| Nenhum cutover | PASS | desenvolvimento não equivale a produção |
| Compatibilidade de `User.role` | PASS | contrato legado preservado |
| `TenantMembership.role` não promovido prematuramente | PASS | autoridade runtime não muda nesta etapa |
| Rollback/abort documentado | PASS | promoção é interrompida em qualquer condição de parada |
| Fixtures A×B sintéticas e descartáveis | PASS | produção não será harness |
| `DATABASE_SCHEMA_MODE=external` | PASS | preparação implícita continua proibida |
| `TENANCY_MODE=disabled` | PASS | ativação produtiva não autorizada |
| Entregas incrementais por PR | PASS | mega-PR proibida |
| Harness/evidência por migration | PASS | promoção independente e auditável |
| Aprovação humana explícita | PASS | decisão fornecida no comando da tarefa |

## Decisão humana

O Comitê humano, por meio da autorização explícita fornecida à tarefa, aprova a abertura controlada
do desenvolvimento do **primeiro estágio EXPAND** da Sprint 1.0B.2 e aceita os guardrails e gates
acima. O registro não simula nomes ou assinaturas que não foram fornecidos.

**DEVELOPMENT APPROVED ≠ PRODUCTION CUTOVER APPROVED.**

## Escopo autorizado

1. inventário final dos roots empresariais;
2. migration expand com `tenantId` **NULLABLE**;
3. FKs e índices somente quando seguros na fase expand;
4. migration sem backfill;
5. runner futuro de backfill separado, auditável e reconciliável;
6. scaffolding progressivo de `TenantContext`;
7. compatibilidade com o `User.role` atual;
8. fixtures A×B sintéticas e descartáveis;
9. testes fail-closed;
10. runtime produtivo permanentemente `disabled` durante esta autorização.

## Fora do escopo

Não estão autorizados: cutover multiempresa; habilitar `TENANCY_MODE` em produção; segundo tenant
produtivo; RLS produtiva; `tenantId NOT NULL`; remoção das constraints globais atuais; backfill
produtivo; mudança global de JWT; remoção de `User.role`; deploy da nova arquitetura; alteração de
dados produtivos; ou migração massiva dos 27 models em uma única PR.

## Guardrails

- `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled` permanecem invariantes;
- nenhuma DDL/DML, produção, deploy ou criação de tenant integra esta aprovação documental;
- pais precedem filhos e cada grupo tem migration, harness, evidência e revisão próprios;
- schema expand é aditivo e forward-compatible; backfill nunca é misturado à migration;
- ausência, ambiguidade ou divergência de contexto deve falhar de forma fechada;
- `User.role` permanece compatível e `TenantMembership.role` não assume autoridade cedo;
- rollback/abort é exigido por subfase; reverter Git não equivale a reverter banco;
- cada mudança futura é uma PR pequena, sem promoção automática à fase seguinte.

## Estratégia incremental

O trabalho segue expand → tooling/backfill → contexto/auth compatível → propagação por domínio →
jobs/integrações → certificação A×B. Cada transição exige revisão humana, checks verdes, evidência
própria, reconciliação e ausência das condições de parada. O runner de backfill será idempotente,
separado da migration e inicialmente limitado a dry-run/harness; uso produtivo não está autorizado.

## Subfases propostas

1. **1.0B.2-A — Schema Expand / roots:** fechar inventário e adicionar raízes nullable em lotes
   pequenos, com FKs/índices seguros e sem DML.
2. **1.0B.2-B — Backfill tooling + ledger:** runner separado, batches, hashes, quarentena,
   reconciliação e abort, sem autorização de execução produtiva.
3. **1.0B.2-C — TenantContext/Auth compatibility:** scaffolding fail-closed, dual-read controlado e
   preservação de `User.role` e tokens legados na janela definida.
4. **1.0B.2-D — Data access propagation:** repositories, handlers e raw SQL migrados por domínio,
   pais antes de filhos.
5. **1.0B.2-E — Jobs/integrations:** envelopes, locks, caches, webhooks e ERP tenant-aware, sem
   execução tenantless quando houver ativação futura.
6. **1.0B.2-F — A×B certification:** fixtures exclusivamente sintéticas e descartáveis, matriz
   negativa/IDOR e relatório de reconciliação.

## Condições de parada

Suspender imediatamente o avanço diante de: migration destrutiva; backfill misturado ao expand;
necessidade de alterar produção para testar; perda da compatibilidade default-only; necessidade de
ativar `TENANCY_MODE` antecipadamente; impossibilidade de rollback/abort; cross-tenant access que
não seja fail-closed; alteração não planejada de auth/JWT; divergência entre `main` e documentação;
ou CI Docker/PostgreSQL vermelho.

## Gate de produção

O gate de produção permanece separado e fechado. Ele exigirá, em decisão futura, backfill e
reconciliação completos, constraints apropriadas, TenantContext/runtime tenant-aware, auth/RBAC,
data access e jobs fail-closed, RLS defensiva, provas A×B, restore/rollback, observabilidade e novas
aprovações de Segurança/LGPD, DBA, QA e Operação. Esta decisão não autoriza piloto, deploy, DDL,
DML, dados produtivos ou tráfego multiempresa.

## Decisão final

`READY_FOR_1_0B_2_DEVELOPMENT = YES`

Autorizado somente o desenvolvimento incremental do primeiro estágio EXPAND, sob os limites deste
documento.

`READY_FOR_MULTI_TENANT_CUTOVER = NO`

Multiempresa continua não ativa e o cutover permanece expressamente não autorizado.
