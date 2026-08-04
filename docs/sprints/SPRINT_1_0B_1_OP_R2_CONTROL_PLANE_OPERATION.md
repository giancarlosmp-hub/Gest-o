# Sprint 1.0B.1-OP-R2 — operacionalização limpa do control plane

## Estado e razão do reinício

Esta entrega permanece em **🔵 PR**. A PR #773 foi encerrada sem merge e é tratada como arquivo,
não como base de código. O checkout inicial era o merge `15d3f7e` da PR #772, com worktree limpa e
sem remote configurado; por isso o estado atual do GitHub e seus checks não puderam ser comprovados
localmente. Nenhuma conclusão sobre produção decorre do Git.

A abordagem anterior acumulou reconstrução frágil do predecessor, parser SQL, checkpoints,
diagnóstico e grants sem convergir. O R2 reduz responsabilidades: registry fechado, inspeção de
catálogo read-only, apply administrativo unitário, preparação DML separada e dois bancos de teste.

## Estado anterior autoritativo

A investigação com `git log -S`, `git log --follow` e o tree histórico comprovou que o primeiro
commit a introduzir os cinco objetos do control plane foi
`581fbae0a545f53800db7707ab8b28f52dcd3fa1`. Seu pai direto é
`dc7ceb0f0a23b77fc45a58960f3371b50c7f7365`. Nesse pai existe exatamente um schema Prisma, em
`apps/api/prisma/schema.prisma`, com SHA-256
`0576893d97a0d7b55ca73316cfe6af6774eeccc1e91807fe4fa45c8fdad7f24c`; ele não contém `Tenant`,
`TenantMembership`, `TenantStatus`, `TenantMembershipStatus` ou `TenantRole`. A última migration é
`20260731150000_safe_production_schema_transition`.

Os valores originalmente registrados estavam corretos no clone completo, mas o harness os usava
diretamente por `git show` sem primeiro provar a existência do commit/path. O checkout raso do CI
não disponibilizava o objeto histórico e produziu uma mensagem que mencionava apenas o arquivo do
working tree. A correção configura checkout com histórico completo e usa o resolvedor versionado:
ele valida os commits, relação pai/filho, unicidade e path no tree por `git cat-file`, tokens,
checksum, migration final e última migration antes de gravar o fixture. Não há fallback para o
arquivo em disco, banco vazio, `sed`, regex ou `DROP`.

## Arquitetura e escopo reduzido

1. Registry versionado resolve exclusivamente IDs conhecidos, path, checksum, predecessor,
   objetos, pós-condições e versão de evidência.
2. Preview consulta `pg_catalog`, preserva inventário e diff Prisma read-only e aceita apenas
   `ABSENT_COMPATIBLE` ou `ALREADY_APPLIED` integralmente compatível.
3. Apply, sob confirmação e autoridade administrativa, transmite uma única migration via stdin,
   `psql -X`, `ON_ERROR_STOP` e transação única; `ALREADY_APPLIED` não reaplica DDL.
4. Preparação usa container efêmero em `default-only`, separa dry-run/apply e não altera Compose,
   runtime, seed, deploy ou migrations.
5. O teste usa PostgreSQL 16 isolado: banco A materializa o datamodel final; banco B materializa o
   schema predecessor obtido do Git e recebe a migration exatamente uma vez.

Ficam fora do escopo `tenantId` empresarial, JWT/handlers tenant-aware, RLS, segundo tenant,
cutover, deploy, produção, ativação do runtime, TD-ER-004A e Sprint 1.0B.2. Multiempresa permanece 🔴.

## Lições incorporadas e práticas descartadas

1. Não remover objetos de schema completo para fabricar história; usar o predecessor Git.
2. Não executar a migration inteira como teste de permissão; testar `CREATE TABLE` isolado.
3. Não reaplicar para alegar idempotência; o fluxo detecta `ALREADY_APPLIED`.
4. Não adicionar `IF NOT EXISTS` para ocultar fixture/reaplicação.
5. Não modificar migration histórica/checksum.
6. Não ampliar allowlist para silenciar diff.
7. Não ignorar `CREATE`, `ALTER`, índice, FK, enum, default ou nullability.
8. Não criar parser SQL complexo; comparar banco/datamodel e consultar catálogo.
9. Não confundir falta de visibilidade da role com drift; introspecção usa autoridade aprovada.
10. Não conceder privilégio sem prova.
11. Separar predecessor, control plane, role runtime e preparação.
12. Manter um inventário antes/depois, sem cascata de checkpoints diagnósticos.
13. Docker indisponível resulta em SKIP 77, nunca em diagnóstico conclusivo.
14. Não declarar PR/check verde sem evidência GitHub do mesmo SHA.
15. Interromper e redesenhar em vez de acumular remendos sobre modelo incorreto.

## Critérios de aceite e testes

O catálogo deve provar valores/ordem dos três enums, duas tabelas, colunas/tipos/defaults/nullability,
duas PKs, quatro índices, duas FKs e dois CHECKs. O diff gerenciado final deve ser vazio e objetos
`incident_*` preservados. Dry-run não escreve; apply é Serializable, confirmado, compara o hash do
mesmo estado e reconcilia exatamente uma membership por User. O harness inclui os 30 cenários
negativos enumerados no requisito, por catálogo real quando estrutural e por testes estáticos dos
gates quando operacional.

## Autoridade, riscos e limitações

DDL exige identidade administrativa exata e nunca concede `CREATE` à role runtime. DML requer
credencial operacional temporária com SELECT apenas de `User.id/role/isActive` e SELECT/INSERT/UPDATE
em `Tenant`/`TenantMembership`, sem DDL, PII ou segredo persistido. Como a main não contém um
mecanismo aprovado para provisionar essa credencial temporária, **o apply real da preparação fica
bloqueado** até procedimento/ADR aprovado; o harness usa somente dados e roles sintéticos.

Riscos residuais: indisponibilidade da imagem pinada/Docker, concorrência entre dry-run e apply,
visibilidade incorreta do catálogo, evidência antiga e divergência entre Git/check/image. Todos
bloqueiam promoção. Nenhuma VPS, production.env, rede ou volume de produção é usado pelos testes.

## Evidências e gates operacionais

Schema: `/var/log/gest-o/schema/<SHA>/migrations/20260802120000_tenancy_control_plane/` com
`metadata.tsv`, `migration.sha256`, inventários, diffs raw/gerenciado, log sanitizado e `result.tsv`
somente ao final. Preparação: `/var/log/gest-o/tenancy/<SHA>/default-tenant/` com metadata, dry-run,
apply, reconciliação e resultado finais. Uma tentativa não sobrescreve PASS nem contém PII, linhas
reais, URL, token ou credencial.

Antes de operação: merge e checks do mesmo SHA, imagem OCI local pinada, HEAD=origin/main, worktree
limpa, backup/preflight PASS, container/database/identidade aprovados, predecessor e checksum PASS,
preview PASS e revisão humana. Rollback não contém `DROP`: runtime segue `disabled`, código antigo
ignora tabelas aditivas e restore/correção de dados exige procedimento separado aprovado.

## Gates para 1.0B.2

1. Docker Compose CI e Preview Deploy verdes no SHA efetivamente publicado.
2. Execução operacional futura revisada, com evidências finais PASS e sem PII.
3. Autoridade DML temporária aprovada e removida após uso.
4. Reconciliação e diff pós-preparação PASS, runtime ainda `disabled`.
5. Nova aprovação do Comitê; este R2 não inicia 1.0B.2.
