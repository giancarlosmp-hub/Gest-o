# Sprint 1.0B.1-OP — operação segura do control plane default-only

**Estado:** 🔵 PR em 02/08/2026. Nenhuma VPS/produção foi acessada; migration, preparação, deploy e cutover não foram executados. Multiempresa permanece 🔴.

## Objetivo, problema e estado inicial

Operacionalizar, para execução futura autorizada, quatro autoridades independentes: **A)** preview read-only; **B)** DDL administrativo da migration registrada; **C)** dry-run de reconciliação; **D)** DML administrativo confirmado. O estado inicial tinha apply fixo na migration `20260731150000`, evidência única por SHA e runner dependente de Git, portanto não suportava a imagem runtime pinada.

## Diagnóstico obrigatório

1. **Não:** o apply inicial aplicava somente um arquivo constante.
2. **Sim:** estava hardcoded em `20260731150000_safe_production_schema_transition`.
3. `applied.tsv` representa **uma migration**, embora seu diretório por SHA e o diff integral tenham sido usados historicamente como prova do estado gerenciado completo.
4. Sim: o leitor legado é mantido e novas provas ficam em `migrations/<MIGRATION_ID>`; nenhum PASS histórico é reescrito.
5. No SHA atual, o pós-diff integral fica vazio somente após a migration anterior **e** a migration do control plane. Um diff vazio continua não provando CHECKs customizados.
6. A allowlist anterior reconhecia enums/tabelas/índices/FKs do control plane, mas **não** reconhecia CHECKs como instruções próprias.
7. **Não de forma suficiente:** Prisma 5.22 não representa CHECK constraints customizadas no schema/diff; por isso o gate consulta `pg_constraint` e valida nomes/tipos separadamente.
8. A imagem API não contém Git nem `.git`; contém `APP_COMMIT`, label OCI, Prisma/schema e JS compilado do runner.
9. Sim, após o contrato operacional: executa o JS compilado sem checkout Git.
10. O wrapper compara `EXPECTED_SHA`, `APP_COMMIT` e label OCI e monta manifesto efêmero cujo SHA-256 é validado pelo runner.
11. DDL só passa por `docker exec --user postgres ... psql -X --single-transaction`; a URL runtime fica restrita ao diff/leitura e não recebe `CREATE`.
12. Scripts, confirmações, transações e diretórios distintos separam schema e preparação; DDL nunca cria Tenant/Membership.
13. Schema usa evidência por migration e manifesto integral; preparação usa `tenancy/<SHA>/default-tenant/attempts` e manifestos PASS separados.
14. O Compose não define `TENANCY_MODE=default-only`; a variável existe apenas no container efêmero do runner. O runtime permanece disabled/não integrado.

## Registry e migration autorizada

O registro fechado `scripts/production-schema-migrations.mjs` autoriza apenas as migrations `20260731150000_safe_production_schema_transition` e `20260802120000_tenancy_control_plane`, com path fixo, SHA-256, predecessor, objetos, tipo, idempotência, pós-condição e versão de evidência. Novo ID exige código, teste, revisão e PR; path do operador não é aceito.

## Ordem operacional futura e separação de autoridades

1. Atualizar `main`, confirmar checkout limpo e SHA; 2. construir a imagem e conferir label; 3. backup validado e preflight; 4. preview read-only; 5. revisão; 6. apply DDL confirmado; 7. conferir `schema-state.tsv`; 8. dry-run DML; 9. revisão humana; 10. apply DML confirmado; 11. reconciliação; 12. manter runtime disabled e não fazer cutover; 13. somente avaliar gate 1.0B.2.

A preparação usa credencial administrativa temporária (`DML_DATABASE_URL`) somente no container efêmero pinado. Ela deve ser distinta da URL runtime, nunca impressa ou persistida na API. Não foi criada role permanente; uma role operacional nova exigiria ADR. O operador deve fornecer autoridade de menor privilégio: `SELECT` em `User` e DML em `Tenant`/`TenantMembership`, sem `CREATE`, sem superuser para runtime.

## Evidências

Schema: `/var/log/gest-o/schema/<SHA>/migrations/<ID>/` contém metadata, checksum, diffs raw/filtrado, inventários, log sanitizado, pós-objetos e resultado; `schema-state.tsv` só nasce após diff integral vazio. `applied.tsv` legado continua legível. Preparação: `/var/log/gest-o/tenancy/<SHA>/default-tenant/attempts/<timestamp>/`; dry-run/apply têm manifestos PASS imutáveis separados. Tentativas incompletas permanecem. Logs não incluem nome, e-mail, senha/hash, tokens ou credenciais ERP.

## Gates, pós-condições e critérios de aceite

Apply exige confirmação, SHA/branch/main/worktree, label OCI, backup/preflight, checksum, predecessor, alvo/container/database e diff fail-closed. Catálogo valida 3 enums, 2 tabelas/PKs, 4 índices, 2 FKs e 2 CHECKs. Antes da preparação as tabelas ficam vazias. A reconciliação exige exatamente o tenant `tenant-default-v1`/`default-v1` ativo, um membership ativo/version 1 por User, mapeamento fechado de roles, nenhuma órfã/duplicada/incompatível, contagem e campos de User preservados e hash agregado esperado.

## Riscos e limitações probatórias

Scripts e testes descartáveis não comprovam execução, backup, conteúdo, permissões ou runtime de produção; Git não é evidência de produção. Prisma diff não prova CHECKs, mitigado por catálogo. A URL DML temporária continua sendo segredo operacional e deve ter mínimo privilégio. CI real e Docker verde são gates de merge; a criação de arquivos não melhora a nota Enterprise. Corrida entre dry-run/apply é bloqueada pelo hash e transação serializable, mas atividade concorrente exige nova revisão/dry-run.

## Rollback

A migration é aditiva: não há DROP automático; deixar objetos inertes com runtime disabled é menos arriscado que destruir dados/constraints. Preparação não apaga Tenant/Membership. Divergência bloqueia 1.0B.2 e exige plano corretivo separado; restore só em incidente autorizado. Rollback de código ignora o control plane e não altera seus dados.

## Fora do escopo e gates para 1.0B.2

Fora: produção/VPS, deploy/cutover, 23 models empresariais, handlers/JWT/TenantContext, segundo tenant, RLS e ativação multiempresa. 1.0B.2 exige merge/checks, execução operacional autorizada das quatro etapas, evidências revisadas, reconciliação PASS, runtime disabled validado, incidentes/debitos aplicáveis tratados e aprovação humana. TD-ER-004A permanece aberto; TD-ER-004B não iniciado.
