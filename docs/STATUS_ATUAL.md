# 🔵 PR — certificação operacional do control plane default-only (07/08/2026)

**Git/main:** o histórico local comprova a PR #774 mesclada no commit
`57cb0b6da02342c5243e4e4aa6857f3ee870d377` (**🟡 Merge**). As PRs #766–#772 e #774 têm
merge commits locais; a #773 foi encerrada sem merge. O acesso ao remote/GitHub falhou por proxy
HTTP 403, portanto checks e estado remoto atual não foram inferidos.

**Produção:** a última revisão operacional comprovada continua `a08a626`; o merge #774 não é deploy
nem evidência de produção. Esta Sprint 1.0B.1-OP-EXEC permanece **🔵 PR**, prepara certificação e
não acessa produção, não aplica schema/DML e mantém `TENANCY_MODE=disabled`. Consulte o
[Brief OP-EXEC](sprints/SPRINT_1_0B_1_OP_EXEC_CONTROL_PLANE_CERTIFICATION.md).

# 🔵 PR — operacionalização limpa do control plane default-only (04/08/2026)

A PR #773 foi encerrada sem merge. A Sprint 1.0B.1-OP-R2 recomeça da `main` com registry fechado,
preview read-only, apply administrativo separado, preparação dry-run/apply e harness PostgreSQL 16
baseado no schema predecessor obtido do Git. Nada foi executado em produção; o apply DML real segue
bloqueado até existir autoridade temporária aprovada, `TENANCY_MODE` permanece `disabled` e
Multiempresa permanece 🔴. Consulte o [Brief R2](sprints/SPRINT_1_0B_1_OP_R2_CONTROL_PLANE_OPERATION.md).

# Histórico — persistência default-only do control plane (02/08/2026)

A Sprint 1.0B.1 adiciona em PR a migration aditiva de `Tenant`/`TenantMembership`, tenant default
determinístico, preparação transacional auditável, adapter Prisma e testes descartáveis. Não houve
produção, apply ou deploy; nenhum model empresarial ganhou `tenantId`, handlers/JWT não foram
integrados e Multiempresa permanece 🔴. Consulte o [Brief](sprints/SPRINT_1_0B_1_CONTROL_PLANE_PERSISTENCE.md).

# 🔵 PR — fundação do control plane multiempresa (02/08/2026)

A Sprint 1.0A aceita a ADR 003 sob gates obrigatórios, cria threat model STRIDE, RACI, contratos
de `Tenant`, `TenantMembership` e `TenantContext`, provas arquiteturais default-only e o plano da
migration expand futura. Não há migration, backfill, RLS, deploy, produção acessada ou segundo tenant.
O Gest-o continua single-tenant e Multiempresa permanece 🔴. Consulte o
[Sprint Brief](sprints/SPRINT_1_0A_MULTI_TENANCY_FOUNDATION.md).

# 🔵 PR — assessment e roadmap Enterprise Multi-Tenancy (02/08/2026)

A Sprint 0.6 confirma que o checkout é single-tenant: somente quatro models de Communications têm
`tenantId` parcial; identidade, 23 models centrais, APIs, raw SQL, caches, schedulers e ERP não têm
boundary empresarial ponta a ponta. O inventário e o roadmap 1.0A–1.0F estão no
[`TENANCY_ASSESSMENT.md`](TENANCY_ASSESSMENT.md), e a ADR 003 propõe schema compartilhado com
isolamento por linha. A entrega é somente documental: não cria migration, não altera API/banco,
não acessa produção e não muda o estado de incidentes ou débitos.

# 🔵 PR — validação operacional Enterprise repetível (02/08/2026)

A Sprint 0.5 cria uma única rotina estritamente read-only para responder, por SHA, se uma instalação
está saudável. A rotina consolida runtime, containers, imagens, rede, storage, sistema, segurança e
ERP em TSVs sanitizados sob `/var/log/gest-o/health/<SHA>/`; `result.tsv` só é emitido ao final.
Esta entrega não acessou produção ou banco, não realizou deploy/restore e não altera o estado dos
incidentes nem transforma o Git em evidência de produção. Consulte o
[Sprint Brief](sprints/SPRINT_0_5_ENTERPRISE_OPERATIONAL_VALIDATION.md).

# 🟢 Produção validada após cutover — 01/08/2026

# 🔵 PR — preparação de validação operacional de segurança e restore (02/08/2026)

A Sprint 0.4 prepara um validador pós-deploy exclusivamente read-only e a ordem operacional
`deploy → SHA → segurança → estabilidade → restore separado`. O histórico local confirma os merges
das PRs #766 e #767, mas a atualização do remote falhou no proxy (HTTP 403), impedindo verificar
GitHub/checks atuais; não houve VPS, deploy ou restore. TD-ER-001/002 continuam aguardando deploy e evidência por SHA;
TD-ER-003 continua aguardando ensaio com cópia aprovada. Nenhum incidente, inclusive
`INC-PROD-2026-07`, foi encerrado. Consulte o [Sprint Brief](sprints/SPRINT_0_4_SECURITY_RESTORE_OPERATIONAL_VALIDATION.md).

# 🔵 PR — ensaio isolado de backup e restore (02/08/2026)

A Sprint 0.3 adiciona prova descartável em PostgreSQL 16, com checksum, catálogo, pós-condições,
cleanup e evidência sem dados, além de propor RPO/RTO. Não houve VPS, dump ou restore real. O teste
sintético não comprova restore de produção: `INC-PROD-2026-07` e `TD-ER-003` permanecem abertos em
correção/validação, dependentes de merge, check Docker e validação operacional futura. Consulte o
[Sprint Brief](sprints/SPRINT_0_3_BACKUP_RESTORE_READINESS.md).

## Comprovado

- schema aplicado em produção, com `applied.tsv`, checksum da migration validado e
  `post-apply-diff.sql` gerenciado vazio;
- cinco tabelas, sete enums e duas colunas de `Contact` confirmados, com as oito tabelas
  `incident_*` preservadas;
- cutover local concluído para `a08a62670c4940322ce037d0c86c54959db32f71` e novos containers de
  API e WEB iniciados;
- CRM acessado após o cutover, com login e navegação funcionando;
- sincronização de clientes aprovada, cliente ERP 5050 presente e Saúde da Plataforma disponível;
- banco preservado e nenhum relato de perda de dados após o cutover.

A validação complementar falhou apenas porque `API_IMAGE` e `WEB_IMAGE` não estavam exportadas no
shell que executou `docker compose ps`, **depois** da mensagem “Cutover concluído localmente”. Isso
não invalida o deploy já executado, mas também não substitui as verificações pendentes abaixo.

## Ainda pendente

- consolidar a evidência técnica externa de API/WEB por SHA em `/health/version` e
  `build-info.json`, caso as saídas não tenham sido preservadas;
- validação prolongada de estabilidade;
- restore integral em ambiente isolado e definição de RPO/RTO;
- fechamento formal dos incidentes segundo todos os seus critérios;
- correção dos P0 de segurança TD-ER-001 e TD-ER-002.

# 🔵 PR — remoção dos P0 locais de autenticação (02/08/2026)

A Sprint 0.2 remove do runtime `/debug/admin`, sanitiza login e bootstrap administrativo e adiciona
testes negativos de rota, contrato, logs, erro, rate limit e autenticação. TD-ER-001 e TD-ER-002
estão em **correção em PR**, não encerrados: merge, deploy e validação por SHA continuam obrigatórios.
Não houve acesso ou alegação sobre produção; Segurança e LGPD não estão integralmente resolvidas.
Consulte o [Sprint Brief](sprints/SPRINT_0_2_AUTH_SECURITY_P0.md).

# 🔵 PR — baseline de Enterprise Readiness reconciliada (02/08/2026)

A Sprint 0.1 cria uma baseline documental/read-only em 17 dimensões e um backlog de achados baseado
em evidências do repositório. Nenhum código de aplicação, banco, migration, Docker, deploy, VPS ou
produção foi alterado ou acessado. A entrega não declara o Gest-o Enterprise-ready, não infere
produção pelo Git e não encerra `INC-5050-4484`, `INC-ERP-5050` nem `INC-PROD-2026-07`.
Consulte [`ENTERPRISE_READINESS.md`](ENTERPRISE_READINESS.md),
[`TECH_DEBT.md`](TECH_DEBT.md) e o
[`Sprint Brief`](sprints/SPRINT_0_1_ENTERPRISE_READINESS.md).

# 🔵 PR — governança de desenvolvimento institucionalizada (01/08/2026)

O Comitê de Arquitetura, o Sprint Brief obrigatório, o ciclo de ADR, a avaliação de Enterprise
Readiness, a revisão de PR e a Definition of Done foram consolidados em
[`GOVERNANCA_DESENVOLVIMENTO.md`](GOVERNANCA_DESENVOLVIMENTO.md). A mudança é exclusivamente
documental: não altera aplicação, banco, deploy, produção, incidentes ou os bloqueios atuais. A
ausência de uma baseline própria de Enterprise Readiness foi registrada como recomendação formal de
backlog, sem implementação automática.

# Histórico — allowlist exata para reutilização da evidência de schema (01/08/2026)

O diagnóstico read-only na VPS confirmou `applied.tsv` e checksum íntegros, migration autorizada
idêntica, `post-apply-diff.sql` vazio e a árvore `apps/api/prisma` equivalente. O bloqueio ocorreu
somente porque a allowlist operacional não acompanhava os arquivos de deploy, rollback e
documentação modificados pelas próprias PRs. Esta PR limita a reutilização aos oito caminhos
operacionais explicitamente autorizados e registra no log qualquer caminho bloqueador. Produção e
containers antigos continuam preservados; nenhum cutover ou deploy ocorreu, o incidente permanece
aberto, o cutover segue pendente e o estágio continua 🔵 PR.

# Histórico — correção de URI Prisma para `psql` após tentativa controlada (01/08/2026)

O apply controlado foi iniciado na VPS. Preflight, backup, allowlist e validação da migration
passaram, mas a execução foi interrompida antes da aplicação SQL: o `psql` rejeitou o parâmetro
Prisma `?schema=public` presente em `DATABASE_URL`. Nenhuma migration foi aplicada, nenhuma tabela
foi alterada e nenhum cutover ocorreu. A sanitização automática da conexão está nesta PR. Após o
merge e todos os checks verdes, o próximo passo é atualizar a `main` na VPS e repetir
`production-schema-apply.sh` desde o início; o schema apply e o cutover continuam pendentes.

# Histórico — Prisma descartável executado pela imagem da API (01/08/2026)

O build da PR #757 foi aprovado, inclusive com Prisma 5.22.0 pinado na imagem da API. A execução
operacional do teste PostgreSQL descartável parou antes de aplicar qualquer migration porque o
checkout da VPS, intencionalmente sem `node_modules`, ainda tentava iniciar o Prisma pelo host. A
correção usa a imagem local do SHA, depois de validar seu label OCI, e conecta essa imagem e um
PostgreSQL temporário por uma rede Docker isolada, sem porta publicada. Nenhum schema foi aplicado,
nenhum cutover ocorreu e a produção permaneceu intacta com os containers anteriores atendendo. O
cutover continua bloqueado e a entrega permanece 🔵 PR.

# Histórico — correção do preflight de schema (01/08/2026)

O teste PostgreSQL descartável comprovou um falso negativo no parser da allowlist: o Prisma 5.22.0
agrupou as duas colunas aditivas aprovadas de `Contact` em uma única instrução `ALTER TABLE`, formato
que o filtro não reconhecia. A migration não foi aplicada, nenhuma produção ou VPS foi acessada e o
cutover continua bloqueado. A entrega permanece 🔵 PR.

# Histórico — deploy seguro preservando PostgreSQL recuperado (31/07/2026)

Código, testes e runbooks foram preparados, sem deploy nem acesso à VPS. A causa é checkout atualizado com containers antigos somado ao risco do Compose genérico iniciar o banco padrão. A candidata contém apenas API/WEB, usa `gest-o_default`, exige banco recuperado e metadados do commit; o cutover é confirmado e reversível. A revisão da PR acrescenta paridade completa de variáveis, rollback executável e Prisma pinado na imagem. Esta PR corrige ainda o falso negativo do preflight: o hostname interno do PostgreSQL é resolvido por `pg_isready` em container efêmero dentro de `gest-o_default`, e não pelo host ou por IP fixo. Nenhum deploy foi realizado e o estágio permanece 🔵 PR. O incidente permanece aberto até execução e validação controladas.

---

==========================================

# GEST-O

## STATUS ATUAL

**Versão:** 3.1

**Última atualização:**

02/08/2026

**Última PR:**

#765

**Último commit:**

PR #765 (reconciliação documental atual); revisão operacional conhecida `a08a626`

### Produção

🟢 Operacional

🟡 **Em Homologação**

🔴 Incidente

### Sprint Atual

**Consolidação UltraFV3**

==========================================

> Resumo operacional de uma página derivado do
> [Documento Mestre 4.0](DOCUMENTO_MESTRE.md), fonte única de verdade. Os indicadores acima formam
> uma legenda; a plataforma está operacional após o cutover, mas os incidentes e gates enterprise
> permanecem em homologação/atenção.

## Onde paramos

- **Concluído:** Dashboard Saúde da Plataforma (PR #749, commit `2f9cfd2`).
- **Parcial:** proteção de identidade UltraFV3 5050×4484 implementada, com regressões A–H e
  auditoria; ainda falta validar as duas filiais independentes e seus perfis em homologação.
- **Próxima funcionalidade:** Activity First, começando por inventário, plano de migração e testes;
  implementação bloqueada até a estabilização.
- **Bloqueadores:** preservar a confirmação externa de SHA de API/WEB, concluir homologação
  5050×4484, publicar veredito ERP 5050, testar restauração de backup, corrigir os P0 de segurança e
  revisar hardening da VPS.

## Próxima sprint

1. Concluir os gates P0 operacionais e de segurança ainda abertos; Git local não substitui evidência.
2. Submeter a ADR 003 ao Comitê e iniciar 1.0A somente após aceite, threat model e owners definidos.
3. Não criar migration de tenancy antes dos gates de control plane, backfill e rollback do assessment.
4. Manter homologação 5050×4484, restore e estabilidade como dependências, sem misturá-los à tenancy.

## Incidente aberto

**INC-5050-4484 — EM HOMOLOGAÇÃO.** O 5050 foi confirmado no CRM. O incidente permanece nesse estado enquanto qualquer filial esperada
estiver ausente. Encerramento exige revisão confirmada, A–H aprovados, 5050/4484 com identidades
próprias, perfis reconciliados e evidências preservadas. O `INC-ERP-5050` registra recuperação
funcional do 5050, mas continua investigando a causa do arquivamento/ausência. O
`INC-PROD-2026-07` permanece corrigido aguardando encerramento, validação prolongada e restore isolado.

## Último deploy

A última revisão operacional conhecida é `a08a62670c4940322ce037d0c86c54959db32f71`: schema aplicado,
cutover local concluído e novos containers API/WEB iniciados. PostgreSQL, database `salesforce_pro`,
rede `gest-o_default` e tabelas `incident_*` foram preservados. A convergência do SHA público via
`/health/version` e `build-info.json` continua não comprovada caso suas saídas não tenham sido
preservadas.

## Última PR

**#765**, “docs: cria baseline de Enterprise Readiness do Gest-o”, em 🔵 PR. O histórico de #751 foi
substituído neste cabeçalho consolidado, sem apagá-lo das entradas históricas.

## Próximos passos

1. Fechar todos os P0 com evidência objetiva.
2. Corrigir TD-ER-001 e TD-ER-002 na primeira Sprint de implementação após esta baseline.
3. Só então iniciar Activity First; não ampliar IA, canais, Financeiro, Fretes, aplicativo ou ERP futuro.

## Histórico — gate de schema de produção em 31/07/2026

O cutover permanece bloqueado. O preview encontrou DDL aditiva legítima e oito tabelas históricas
`incident_*` que `prisma db push` tentaria excluir. Foi preparado fluxo versionado de preview/apply,
sem acesso à VPS ou produção; o banco recuperado permanece preservado. As imagens do commit
`a2daeb5e2b8470a8a68bc5e5b164627a7cc18743` foram construídas, mas não publicadas. O incidente
5050×4484 continua em homologação. Consulte a [auditoria](investigations/production-schema-transition-july-2026.md).

## Histórico — tentativa segura de schema apply em 01/08/2026

No SHA `6041ddac24a6be0bb85a63498656b4d183ccd5d7`, o apply passou pelos gates, chegou à
transação única e falhou no primeiro `CREATE TYPE` com `permission denied for schema public`.
A causa é correta do ponto de vista de segurança: a role da `DATABASE_URL` é a identidade runtime e
não tem `CREATE` em `public`. A transação não persistiu alteração, nenhuma migration foi concluída,
as oito `incident_*` permaneceram preservadas e não houve cutover.

A correção em 🔵 PR mantém a URL runtime para Prisma, leituras e health checks, mas entrega somente a
transação DDL e validações administrativas indispensáveis ao `postgres` local do container
`gest-o-db-clean-v2-20260717`, via `docker exec --user postgres`. Não há concessão permanente,
troca de owner, senha administrativa ou porta publicada. Produção **não** está atualizada, o schema
**não** está aplicado e o incidente continua aberto com cutover bloqueado.

## Histórico — segundo ensaio de cutover e rollback híbrido

O schema de produção foi aplicado e validado, e a evidência originalmente emitida para
`0f1391fee481254dc1896a18ec261ef168e5bbe3` foi revalidada com sucesso para o SHA operacional
`c178a69efc79cf78862b697229c7192b607fbcc6`. A segunda tentativa terminou **antes de qualquer
parada de container e antes do cutover**: a imagem `sha256:0ce92e...`, referenciada pelo container
histórico `gest-o-api-recovery-20260718`, já não existia no catálogo local do Docker.

Os containers antigos continuaram running e atendendo, PostgreSQL/schema foram preservados e o
cutover segue pendente. Esta 🔵 PR adiciona rollback híbrido por role: imagem quando o objeto ainda
existe; container histórico externo, por nome e ID exatos, quando a imagem desapareceu. O incidente
não está encerrado e nenhuma conclusão de cutover deve ser inferida desta correção.
