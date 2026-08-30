# Production Schema PR827 — lições consolidadas do rollout

## Evidência conclusiva do legado — run 33213116026 / job 98990686108

O diagnóstico read-only comprovou database, usuário administrativo, schema e `search_path` esperados em PostgreSQL 16.14, e distinguiu ausência global de `_prisma_migrations` de invisibilidade. Os catálogos de tenancy e PR827 estavam ausentes e nenhuma escrita ocorreu. A causa raiz foi impor um ledger Prisma e o predecessor de tenancy escolhido pela ordem dos diretórios, embora produção use bundles `applied.tsv` da transição SQL de julho.

O contrato corrigido trata `20260731150000_safe_production_schema_transition` como baseline real e valida `ErpOrderSync.id`, `Opportunity.id`, `User.id` e `Role`. O SQL PR827 não referencia Tenant nem `tenantId`. Preview dispensa imagem e não escreve. Apply mantém confirmação, SHA, backup, imagem, transação, publicação atômica, catálogo exato, diff vazio e idempotência.

Data de consolidação: 2026-08-28. Este registro não é autorização operacional.

| Falha observada | Causa | Correção | Regressão obrigatória |
|---|---|---|---|
| `production environment file absent` (run `33196976100`, job `98936493036`) | O workflow assumia o caminho canônico, mas a fonte real era a cópia legada protegida. | Usar o resolvedor existente, exigir exatamente uma fonte e entregar ao runner somente classe e referência validada. | `pr827-production-env-safety.sh`: cardinalidade, arquivo regular, owner/mode, sintaxe, `DATABASE_URL` única e hash imutável. |
| token literal `:'migration_name'` (run `33199668348`, job `98945662977`) | `psql -c` não fez a substituição esperada e enviou o token ao servidor. | SQL em stdin por heredoc literal e valor em `--set`, depois da allowlist. | `pr827-schema-runner-safety.mjs`: proíbe interpolação shell e `-c` no bloco parametrizado. |
| `_prisma_migrations` ausente (run `33204493337`, job `98961963978`) | O runner novo assumiu um ledger Prisma, contrariando o contrato histórico documentado: produção foi sincronizada por `prisma db push` e a transição SQL de julho gerou `applied.tsv`, não ledger. A mensagem isolada prova apenas que a relação não estava visível no `search_path`; ainda não prova ausência global nem exclui outro schema. | O preview passa a classificar conexão, schema, `search_path`, versão PostgreSQL, localização/visibilidade do ledger, catálogo predecessor e catálogo PR827, somente em transações read-only. Ledger ausente ou fora de `public` continua falha fechada; apply segue bloqueado. | Teste estático exige todas as sondagens sanitizadas, `BEGIN TRANSACTION READ ONLY`, ausência de DDL/DML no diagnóstico e falha antes da consulta ao ledger. |
| SQL diagnóstico inválido (run `33206303362`, job `98968114798`) | A revisão foi somente estática e aceitou `current_schemas(false)[1]`, sintaxe que o PostgreSQL 16 rejeita. | O acesso posicional agora é `(current_schemas(false))[1]`; os blocos reais foram extraídos para arquivos únicos, executados pelo runner e pelo harness. | `test:pr827-preview:postgres` executa conexão, ledger, predecessor e catálogo PR827 reais, cobre todos os estados e `search_path`, e prova que uma escrita em transação read-only é recusada. |

## Contrato legado proposto, não adotado automaticamente

Se a nova sondagem confirmar ledger globalmente ausente, classificar a história como
`LEGACY_NO_PRISMA_LEDGER`: exigir catálogo exato dos 11 roots da migration predecessor,
checksum versionado, evidência histórica `applied.tsv`/diff do SHA correspondente e revisão
humana auditada. Isso pode provar a precondição estrutural, mas **não** equivale a registro
Prisma e não autoriza o runner atual a inserir baseline. A eventual criação/adoção de ledger
é uma mudança operacional separada. Até essa decisão, preview termina em erro e apply não é
alcançável.
