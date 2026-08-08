# Sprint 1.0B.1-OP-EXEC — certificação do control plane default-only

## Contexto e estado inicial

O histórico local inicia em `57cb0b6da02342c5243e4e4aa6857f3ee870d377`, merge da PR #774.
Os merges locais #766–#772 e #774 estão presentes; #773 não possui merge e foi encerrada. O remote
não pôde ser atualizado nem consultado por bloqueio de proxy HTTP 403, logo GitHub/checks atuais são
gate não comprovado. A revisão operacional de produção conhecida continua `a08a626`; merge não é
deploy. Esta Sprint está **🔵 PR** e não executa produção.

Legenda: **🟣 Codex** trabalho local; **🔵 PR** revisão; **🟡 Merge** em `main`; **🟠 Deploy**
publicação comprovada; **🟢 Produção** validação operacional por SHA. Nenhuma etapa implica a seguinte.

## Estado produtivo recebido e pausa antes da Fase 7 (07/08/2026)

No SHA `672d985ca0bcb22a78e7c25d8b3e31ee0f41f4cd`, as Fases 5 e 6 produtivas foram
registradas como **PASS**: migration em `APPLIED_ONCE`, `Tenant` e `TenantMembership` presentes e
ambas com zero linhas, pós-diff bruto preservado, pós-diff gerenciado vazio (0 bytes) e as oito
tabelas `incident_*` preservadas. O runtime permaneceu com `TENANCY_MODE=disabled` e
`DATABASE_SCHEMA_MODE=external`, sem restart, tenant default ou membership criada. A janela está
pausada antes da Fase 7; isso não declara multiempresa ativo nem inicia a Sprint 1.0B.2.

O wrapper da Fase 7 seleciona explicitamente `READONLY_DATABASE_URL` em `MODE=dry-run`; esse modo
não recebe confirmação nem exige autoridade DML e produz apenas evidência de leitura, plano e hash.
`MODE=apply` seleciona exclusivamente `DML_DATABASE_URL`, exige
`DML_AUTHORITY_PROVISIONING=APPROVED_TEMPORARY_ROLE`, confirmação, backup/preflight PASS e dry-run do
mesmo SHA com hash válido. O apply permanece bloqueado até a aprovação e o provisionamento de uma
role DML temporária de menor privilégio. É proibido substituir essa role pela identidade runtime,
superuser, credencial permanente ou `GRANT` implícito. Internamente, somente a URL selecionada é
exportada ao container como `DATABASE_URL`; nenhuma nova autoridade permanente é criada.

### Revalidação do control plane e hotfix de stdin (08/08/2026)

A migration produtiva já havia sido aplicada anteriormente. O estado produtivo comprovado continua
com `Tenant` e `TenantMembership` presentes, ambas com zero linhas, pós-diff gerenciado de 0 bytes e
as oito tabelas `incident_*` preservadas. Na tentativa de revalidar esse estado no SHA
`f6dd569cbd2fae25da88ce712fe9a6729541e4c3`, o preview registrou falsamente
`ABSENT_COMPATIBLE`: `pre-objects.tsv` ficou com 0 linhas e 0 bytes.

A execução direta do mesmo `scripts/control-plane-catalog.sql`, no mesmo PostgreSQL, com
`docker exec -i ... psql ... -f -`, produziu 43 linhas e 3190 bytes; o validator encerrou com
`CONTROL_PLANE_CATALOG_PASS`. A causa raiz foi o helper do preview usar `docker exec` sem `-i`: em
um fluxo `psql -f -` com redirecionamento de stdin, o SQL do host não foi conectado ao processo no
container e o `psql` recebeu EOF. O hotfix conecta stdin explicitamente e trata falha da consulta
como `CATALOG_QUERY_FAILED`, nunca como ausência legítima. A correção permanece **🔵 PR** e só será
considerada comprovada após testes e CI verdes.

Nenhuma DDL ou DML foi executada durante esse diagnóstico, nenhum tenant default ou membership foi
criado e a Fase 7 permanece suspensa. A auditoria dos scripts operacionais confirmou que o apply já
usa `docker exec ... -i` no helper administrativo, inclusive nos caminhos que enviam a migration por
pipe e o catálogo por `-f -`/redirecionamento. Consultas fornecidas por `-c` e verificações
`pg_isready` não dependem de stdin; os usos de catálogo, migration e heredoc dependentes de stdin
devem sempre portar `-i`.

## Janela suspensa na Fase 3 e hotfix

O **Gate Humano 1** identificou preventivamente um segundo defeito no caminho pós-apply da revisão
`a4002d90f8108699f5fcdad41c78996d017cf050`: o script copiava o diff bruto para o gerenciado e o
validava manualmente, sem o filtro oficial. Se o apply fosse autorizado, os oito drops forenses
esperados poderiam marcar a operação como falha somente depois de a DDL ter sido aplicada. Nenhum
apply produtivo foi executado, nenhuma produção foi alterada e a janela continua suspensa antes da
DDL. O pós-diff agora deve passar por `schema-diff-filter.mjs` em modo `post`, preservando o raw e
aceitando como vazio gerenciado apenas a remoção dos oito drops conhecidos.

A janela autorizada alcançou a Fase 3 após backup **PASS** e preflight **PASS**. No SHA
`5c2a43a3c9537b26813912f54eda9ee73c5da0a7`, o diff bruto continha exclusivamente os oito `DROP
TABLE incident_*` forenses conhecidos, mas o preview copiou o raw para o diff gerenciado e bloqueou
qualquer referência `incident_*`, em vez de chamar `schema-diff-filter.mjs`. O preview falhou antes
de qualquer apply: nenhuma DDL ou DML ocorreu, o control plane continuou ausente e os objetos
forenses foram preservados.

A janela permanece suspensa aguardando o hotfix e nova autorização. O hotfix mantém o raw imutável,
submete o diff gerenciado ao filtro oficial em modo `pre` e continua fail-closed para toda operação
desconhecida ou destrutiva. Ele não comprova atualização de produção e não altera o estado de nenhum
incidente.

## Objetivo, escopo e fora de escopo

O objetivo é tornar auditável, repetível e fail-closed uma futura aplicação do control plane já
mesclado: reconciliar documentos, auditar registry/preview/apply/preparação, fixar o contrato de
schema externo, testar PostgreSQL 16 e especificar evidências e pausas humanas.

Inclui somente `Tenant` e `TenantMembership` default-only, migration registrada
`20260802120000_tenancy_control_plane`, validação estrutural, dry-run/apply idempotente e integração
posterior com health validation. Exclui produção/VPS/deploy/restart, segundo tenant, `tenantId` no
domínio, JWT/handlers tenant-aware, RLS, isolamento A×B, ERP, Activity First e Sprint 1.0B.2.
`TENANCY_MODE=disabled` é obrigatório no runtime.

## Auditoria da PR #774 e gates técnicos

- **Registry fechado:** ID, path e SHA-256 vêm de `production-schema-migrations.mjs`; migration/path
  arbitrário do operador é rejeitado.
- **Preview read-only:** usa catálogo e `prisma migrate diff`; não executa DDL/DML, não toca dados,
  tenant ou ledger. Exige SHA/worktree/origin, imagem pinada, runtime disabled e schema external.
- **Apply de schema:** confirmação própria, SHA/main limpa, registry/checksum, backup e preflight
  PASS, preview do mesmo SHA, imagem pinada e autoridade administrativa temporária. Não há GRANT,
  owner ou DDL concedido ao runtime. `API_IMAGE` é validada antes de DDL.
- **Preparação:** `dry-run` não aceita confirmação e somente lê; `apply` tem confirmação distinta,
  hash do dry-run, role DML temporária aprovada e transação Serializable. Só reconcilia o tenant
  default determinístico, rejeita qualquer tenant adicional e não toca domínio empresarial.
- **Runtime:** Compose fixa `DATABASE_SCHEMA_MODE=external`, `TENANCY_MODE=disabled` e seeds false.
  Bootstrap não executa schema, seed ou sequence em produção; referências antigas a `db push` são
  históricas.

Ausência de gate é **FAIL**, nunca PASS. `SKIP` exige razão explícita e não promove a release.

## Riscos e dependências

Riscos: remote/checks indisponíveis, imagem/postgres:16 ausente, drift, evidência obsoleta, concorrência
entre revisão e apply, autoridade temporária DML ainda sem provisionamento aprovado e backup/restore
operacional não comprovado. Dependências: owners DBA/Segurança/Operação, janela aprovada, release e
imagens pelo mesmo SHA, backup legível, preflight PASS e armazenamento seguro. Incidentes
`INC-5050-4484`, `INC-ERP-5050`, `INC-PROD-2026-07` e TD-ER-001/002/003 mantêm seus estados; Git não
os encerra.

## Sequência operacional única para futura janela autorizada

### FASE 0 — Identificação
Registrar SHA esperado, `main=origin/main` limpa, candidata, operador, aprovadores, janela, topologia,
PostgreSQL/database/volume/rede exatos e imagens OCI. Divergência: **FAIL/ABORT**.

### FASE 1 — Backup
Criar backup lógico novo, SHA-256, localização protegida e prova de legibilidade; nunca sobrescrever
evidência anterior. Não incluir segredo nos metadados. Falha: **ABORT**.

### FASE 2 — Preflight read-only
Confirmar SHA, imagens, containers, rede, PostgreSQL 16, database, volume, permissões mínimas, espaço,
registry/checksum e migration esperada. Persistir PASS/FAIL; não escrever no banco.

### FASE 3 — Preview
Executar apenas `production-tenancy-control-plane-preview.sh`. Persistir inventário/diff sanitizado e
PASS (`ABSENT_COMPATIBLE` ou `ALREADY_APPLIED`) ou FAIL. Nenhuma escrita.

### FASE 4 — Revisão humana
Interrupção obrigatória. DBA, Segurança e Operação revisam fases 0–3. Não existe encadeamento
automático ao apply; registrar decisão separada.

### FASE 5 — Schema apply
Com nova autorização, executar `production-tenancy-control-plane-apply.sh`, DDL mínimo pela autoridade
administrativa temporária, transação quando aplicável e evidência imutável. O runtime não recebe DDL.

### FASE 6 — Post-schema validation
Confirmar tabelas, enums, constraints, índices, migration/checksum, diff gerenciado vazio e objetos
históricos (inclusive `incident_*`) preservados. Drift inesperado: FAIL e interromper.

### FASE 7 — Tenant default dry-run
Executar `MODE=dry-run` sem `CONFIRM`. Zero escrita; registrar somente contagens, plano e hash
agregado sanitizados.

### FASE 8 — Revisão humana
Nova interrupção obrigatória. Revisar plano, hash, autoridade DML temporária e ausência de segundo
tenant; registrar autorização separada.

### FASE 9 — Tenant default apply
Executar `MODE=apply` com `CONFIRM=PREPARE_DEFAULT_TENANT`, hash do dry-run e role temporária mínima.
DML idempotente em transação Serializable, exclusivamente no tenant default.

### FASE 10 — Validação
Confirmar exatamente um tenant default, uma membership coerente por usuário, ausência de duplicação,
órfão, segundo tenant ou alteração empresarial, e `TENANCY_MODE=disabled` no runtime.

### FASE 11 — Certificação operacional
Após janela e autorização próprias, integrar o resultado com `scripts/production-health-validation.sh`.
Não executar nesta PR. Resultado de cada fase: PASS, FAIL ou SKIP justificado; qualquer ausência de
teste permanece não comprovada.

## Evidências por SHA

Raiz sugerida: `/var/log/gest-o/control-plane/<SHA>/attempt-<UTC>/`, modo `0700`, arquivos `0600`:
`00-identification`, `01-backup`, `02-preflight`, `03-preview`, `04-approval`, `05-schema-apply`,
`06-post-schema`, `07-tenant-dry-run`, `08-approval`, `09-tenant-apply`, `10-validation` e
`11-certification`, cada qual com `result.tsv`. Uma tentativa concluída é imutável.

Permitidos: SHA, IDs registrados, checksums, timestamps UTC, versões, image digests, nomes lógicos
aprovados, contagens e resultados. Proibidos: senha, token, `DATABASE_URL`, PII, documento completo,
IDs/linhas de usuário, payload empresarial e logs brutos não sanitizados.

## Rollback

Antes de DDL/DML: abortar sem mudança. Após schema: manter objetos aditivos inertes com runtime
`disabled`; não executar DROP automático. Após preparação: interromper promoção; correção de dados ou
restore exige plano, aprovação e janela separados. Reverter código por PR não reverte banco.

## Responsabilidades

Operação é accountable pela janela/evidência; DBA executa e aprova schema/DML; Segurança aprova
menor privilégio e sanitização; Release valida SHA/imagens/checks; QA revisa harness/resultados;
Arquitetura garante limites default-only; Product/TPM controla gates e impede 1.0B.2. Ausência de
ocupante ou aprovação bloqueia.

## Critérios de aceite e definição de concluído

Aceite exige: #774 reconciliada como 🟡 Merge, produção não inferida; fluxo único; registry fechado;
preview e dry-run read-only; autorizações separadas; SHA/mode divergentes fail-closed; autoridades
separadas; harness PostgreSQL 16 completo e negativo; lint/typecheck/build/testes verdes; nenhuma
produção/VPS/deploy/schema/DML real; incidentes e débitos não encerrados; nenhuma 1.0B.2.

Esta Sprint conclui quando a PR OP-EXEC for revisada/mesclada e seus checks do mesmo SHA estiverem
verdes. A futura 1.0B.2 só poderá ser proposta depois de uma janela **separada e autorizada** produzir
PASS revisado nas fases 0–11, remover a autoridade temporária, manter runtime disabled, resolver
bloqueadores e obter nova aprovação do Comitê. Esta PR não concede essa autorização.
