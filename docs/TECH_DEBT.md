# Progresso 1.0B.2-H — descendentes ainda isolados

Adapters de AgendaStop e Activity somente-Agenda existem apenas como prova. Integração dos acessos legados, decisão sobre multi-parent, includes filtrados e saneamento de vínculos históricos seguem abertos. CASCADE/SET NULL continuam exigindo cuidado e não foram alterados.

# Progresso 1.0B.2-E — ownership relacional ainda isolado

Permanecem por migrar acessos de Opportunity/Activity em controllers, dashboard, agenda, IA,
automações, ERP e scripts, inclusive includes, groupBy, operações por ID, cascades e merges.
Activity dual-parent é deliberadamente negada nesta subfase: suportá-la requer comparação e
atomicidade comprovadas no banco, não filtragem ou mock TypeScript. AgendaEvent ainda não é fonte
autorizada; User nunca substitui ownership tenant. Consulte o
[brief](sprints/SPRINT_1_0B_2_E_TENANT_RELATIONAL_OWNERSHIP.md).

`tenantId` nullable, backfill, constraints e RLS seguem fora de escopo. `READY_FOR_TENANT_AWARE_RUNTIME = NO`.

## Dívida herdada — Sprint 1.0B.2-D

# Progresso 1.0B.2-D — propagação por domínio ainda incompleta

O repository isolado de Client prova o contrato, mas acessos Prisma produtivos, ownership transitiva
de Opportunity/Activity, User, uniques/lock ERP, raw SQL, caches, includes e transações ainda
precisam ondas próprias antes de runtime tenant-aware. Consulte o
[brief](sprints/SPRINT_1_0B_2_D_TENANT_DATA_ACCESS_PROPAGATION.md).

# Dívida técnica — achados da Sprint 0.1

> **Progresso 1.0B.2-C (08/08/2026):** TenantContext e resolver fail-closed existem como
> scaffolding isolado com testes A×B sintéticos e compatibilidade legada default-only. TD-ER-004D
> permanece aberto porque JWT, middleware, data access, cache, jobs e RBAC não foram ativados;
> TD-ER-005 permanece integralmente aberto. `TENANCY_MODE=disabled`, sem produção ou cutover.

> **Gate 1.0B.2 (08/08/2026):** a decisão humana explícita autorizou somente o desenvolvimento
> incremental do estágio EXPAND. `READY_FOR_1_0B_2_DEVELOPMENT = YES`, mas
> `READY_FOR_MULTI_TENANT_CUTOVER = NO`; TD-ER-004/004B permanecem abertas e não houve implementação,
> produção ou alteração de dados. Consulte o
> [registro do gate](sprints/SPRINT_1_0B_1_GATE_APPROVAL_FOR_1_0B_2.md).

Este backlog contém somente achados desta auditoria. Ele não implementa correções, não duplica
incidentes e não altera seu estado. `INC-5050-4484`, `INC-ERP-5050` e `INC-PROD-2026-07`
continuam nas fontes oficiais; são dependências referenciadas, não novos itens. Schema e cutover
local foram comprovados posteriormente, sem comprovar restore ou encerramento dos incidentes.

## P0 — risco imediato a dados, segurança ou produção

### TD-ER-001 — Endpoint diagnóstico público expõe metadado de credencial

- **Estado:** correção mesclada na PR #766; aberto até deploy e evidência por SHA.
- **Artefato operacional:** validação sanitizada preparada em
  [`../scripts/production-auth-security-validate.sh`](../scripts/production-auth-security-validate.sh)
  e governada pela [Sprint 0.4](sprints/SPRINT_0_4_SECURITY_RESTORE_OPERATIONAL_VALIDATION.md); a
  existência do artefato não encerra o item.

- **Descrição:** `/debug/admin` não exige autenticação e retorna, quando encontra usuário, prefixo e
  presença material do hash de senha.
- **Fonte:** [`apps/api/src/app.ts`](../apps/api/src/app.ts), rota `/debug/admin`.
- **Severidade:** Crítica.
- **Impacto:** disclosure de identidade e material derivado de credencial; facilita enumeração e
  análise da superfície de autenticação.
- **Dependências:** gate de segurança; confirmar exposição efetiva sem inferir produção pelo Git.
- **Critério de encerramento:** rota ausente ou estritamente protegida em todos os ambientes, com
  teste negativo não autenticado e evidência por SHA/deploy; nenhum hash ou prefixo na resposta.
- **Sprint sugerida:** Épico 1 — Fechamento dos P0 e incidentes.

### TD-ER-002 — Login registra dados pessoais e metadados de hash

- **Estado:** correção mesclada na PR #766; aberto até deploy e evidência por SHA.
- **Artefato operacional:** o mesmo validador compara contratos inválidos e examina somente o
  intervalo sanitizado; execução por SHA ainda é obrigatória.

- **Descrição:** fluxo de login escreve e-mail, ID, prefixo/comprimento de hash e resultado de
  comparação em `console`/eventos.
- **Fonte:** [`apps/api/src/controllers/authController.ts`](../apps/api/src/controllers/authController.ts).
- **Severidade:** Crítica.
- **Impacto:** exposição de dados pessoais e metadados de autenticação em logs, com retenção e acesso
  não comprovados.
- **Dependências:** programa LGPD e política de observabilidade sanitizada.
- **Critério de encerramento:** logs de autenticação minimizados e sanitizados; testes garantem
  ausência de e-mail, ID desnecessário, hash/prefixo/comprimento e resultado de comparação.
- **Sprint sugerida:** Épico 1 — Fechamento dos P0 e incidentes.

### Dependências P0 já existentes — sem duplicação

- `INC-5050-4484`: permanece **EM HOMOLOGAÇÃO**, conforme [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md).
- `INC-ERP-5050`: causa raiz continua não comprovada, conforme
  [`investigations/erp-5050-root-cause-analysis.md`](investigations/erp-5050-root-cause-analysis.md).
- `INC-PROD-2026-07`: schema/cutover e validação funcional estão comprovados; permanece corrigido
  aguardando encerramento, estabilidade prolongada e restore isolado, conforme
  [`STATUS_ATUAL.md`](STATUS_ATUAL.md).

## P1 — bloqueia plataforma comercial

| ID | Descrição | Fonte | Severidade | Impacto | Dependências | Critério de encerramento | Sprint sugerida |
|---|---|---|---|---|---|---|---|
| TD-ER-003 | Restauração e objetivos de recuperação não comprovados — **correção/validação em 🔵 PR na Sprint 0.3; não encerrado** | [`ops/backup.md`](ops/backup.md), [`ops/backup-restore-readiness.md`](ops/backup-restore-readiness.md), [harness](../scripts/smoke/production-backup-restore-postgres.sh), [operação Sprint 0.4](sprints/SPRINT_0_4_SECURITY_RESTORE_OPERATIONAL_VALIDATION.md), [`../restore.sh`](../restore.sh), [`STATUS_ATUAL.md`](STATUS_ATUAL.md) | Crítica | Perda de dados/continuidade não demonstrada | Merge, check Docker, ensaio autorizado e validação operacional | Restore integral ensaiado com checksum, pré/pós-condições, RPO/RTO e evidência aprovada; teste sintético isolado não basta | Épico 1 |
| TD-ER-004 | Tenancy inexistente/incompleta em dados, identidade e processamento — arquitetura/control plane concluídos em código na Sprint 1.0A; isolamento não implementado | [`TENANCY_ASSESSMENT.md`](TENANCY_ASSESSMENT.md), [ADR 003 aceita](adr/003-shared-schema-tenant-boundary.md), [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma) | Crítica | Acesso cruzado por consultas, IDs, FK, cache, job, log, JWT, webhook ou ERP e alegação comercial indevida | Aceite da ADR, identidade, segurança, DBA, restore e SLO | Roadmap 1.0A–1.0F concluído; FK/unique compostas, repository/RLS e testes negativos provam isolamento de banco, cache, jobs, logs e integrações | Épico 4 |
| TD-ER-005 | Gestão de sessão sem rotação/revogação comprovada | [`apps/api/src/controllers/authController.ts`](../apps/api/src/controllers/authController.ts), [`apps/api/src/utils/jwt.ts`](../apps/api/src/utils/jwt.ts) | Alta | Refresh token roubado segue válido até expirar | Política de identidade | Política aprovada; rotação, revogação e testes de replay/logout comprovados | Épico 2 |
| TD-ER-006 | Programa LGPD não documentado | [`ENTERPRISE_READINESS.md`](ENTERPRISE_READINESS.md#matriz-por-dimensão) | Crítica | Direitos, retenção e base legal não demonstráveis | Inventário de dados e jurídico | ROPA, bases legais, retenção, DSAR, responsáveis e evidências de execução aprovados | Épico 2 |
| TD-ER-007 | Oferta, onboarding, licenciamento e suporte ausentes da documentação | [`product/README.md`](product/README.md), [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md) | Alta | Comercialização e operação não repetíveis | Segurança, isolamento e owners | Oferta, limites, termos, provisioning, onboarding/offboarding e suporte aprovados/testados | Épico 5 |

## P2 — importante para escala ou qualidade

### Decomposição oficial do TD-ER-004 (Sprint 0.6)

| Subitem | Lacuna | Gate de encerramento |
| --- | --- | --- |
| TD-ER-004A | Parcialmente cumprido: migration aplicada, tenant default preparado, 8 memberships reconciliadas, runtime validado disabled e evidência operacional preservada; adapter ainda não integrado ao runtime | permanece aberto até o adapter/runtime ser integrado sob gate próprio e o critério completo ser revisado; não confundir control plane default-only com Multiempresa |
| TD-ER-004B | Não iniciado: 23 models centrais sem tenant e quatro Communications parciais | backfill reconciliado; tenant obrigatório e FKs/uniques compostas |
| TD-ER-004C | zero repositories e Prisma/raw SQL sem boundary comum | data-access deny-by-default e teste arquitetural sem escape implícito |
| TD-ER-004D | JWT/RBAC, caches, logs, jobs e locks globais | namespace/contexto tenant e testes concorrentes A×B |
| TD-ER-004E | UltraFV3, IA, CNPJ e webhook/WhatsApp sem isolamento integral | credenciais, quota, conta externa, idempotência e auditoria por tenant |
| TD-ER-004F | ausência de prova, rollout e rollback multiempresa | RLS defensiva, restore/carga/IDOR verdes e piloto por coorte aprovado |

Os subitens detalham, mas não duplicam, TD-ER-004. Nenhum está encerrado. TD-ER-004A possui
prova operacional de migration, default, reconciliação, runtime disabled e evidências, mas continua
aberto porque seu critério também exige integração do adapter/runtime. TD-ER-004B continua **não
iniciado**; esta PR não altera models empresariais nem inicia 1.0B.2. TD-ER-004 geral não é encerrado.

| ID | Descrição | Fonte | Severidade | Impacto | Dependências | Critério de encerramento | Sprint sugerida |
|---|---|---|---|---|---|---|---|
| TD-ER-008 | Ausência de suíte E2E browser e acessibilidade verificável | [`.github/workflows/docker-compose-ci.yml`](../.github/workflows/docker-compose-ci.yml), [`manual-test-checklist.md`](manual-test-checklist.md) | Alta | Regressões de jornada, teclado e leitor de tela | Ambiente estável | Jornadas críticas automatizadas, nível WCAG definido e evidência CI por SHA | Épico 3 |
| TD-ER-009 | SLOs e alertas externos não implementados/comprovados | [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md) | Alta | Detecção tardia e resposta sem dono | Observabilidade e suporte | SLIs/SLOs, alertas com owner/runbook e exercício comprovado | Épico 3 |
| TD-ER-010 | Capacidade e performance não caracterizadas | [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md) | Alta | Saturação e custo imprevisíveis | SLOs e workload | Cenários de carga, metas, resultados, gargalos e limites publicados | Épico 3 |
| TD-ER-011 | Catálogo/versionamento de APIs e integrações ausente | [`erp-ultrafv3-integration-technical.md`](erp-ultrafv3-integration-technical.md), [`communications/secure-omnichannel-foundation.md`](communications/secure-omnichannel-foundation.md) | Alta | Quebras e responsabilidades ambíguas | Arquitetura e owners | Contratos versionados, depreciação, idempotência, quotas e testes de provider documentados | Épico 2 |
| TD-ER-012 | Raw SQL sem inventário/revisão central de risco | Busca em `apps/api/src/services` por `$queryRaw`/`$executeRaw` | Média | Segurança e performance variam por implementação | DBA e padrões de dados | Inventário revisado com parametrização, plano, limites e testes de cada query crítica | Épico 3 |

## P3 — melhoria planejável

| ID | Descrição | Fonte | Severidade | Impacto | Dependências | Critério de encerramento | Sprint sugerida |
|---|---|---|---|---|---|---|---|
| TD-ER-013 | Documentação de arquitetura e produto contém apenas páginas introdutórias | [`architecture/README.md`](architecture/README.md), [`roadmap/README.md`](roadmap/README.md), [`product/README.md`](product/README.md) | Média | Conhecimento concentrado e análise de impacto lenta | Inventário oficial | Mapas atuais de domínio/componentes/ownership e visão de produto vinculados ao mestre | Épico 3 |
| TD-ER-014 | TODO/FIXME sem triagem única | Busca estruturada em `apps/api/src` e `apps/web/src` | Baixa | Dívida pode permanecer invisível ou misturada a texto/dados | Owners por domínio | Ocorrências técnicas confirmadas triadas; falsos positivos descartados e itens válidos rastreados | Épico 6 |

## TD-MT-EXPAND-ROOTS — constraints transitórias após 1.0B.2-A

Os roots da primeira onda possuem ownership nullable, mas uniques empresariais continuam globais, em especial `AppConfig.key`, Product código+classe, metas/territórios por seller e `ErpSyncLock.scope`. A 1.0B.2-D deve migrar data access e medir colisões; a fase constrain posterior substitui constraints somente após backfill e prova A×B. NULL significa registro não migrado e não pode gerar fallback para `tenant-default-v1`.

### Progresso 1.0B.2-B

Plan/dry-run, batches, hashes, quarentena e reconciliação foram implementados com ledger mínimo em
evidência imutável e apply apenas no harness. TD-ER-004B continua aberto: nenhuma linha real mudou;
lock/autoridade operacional seguem para 1.0B.2-C e não há isolamento runtime.

### Progresso 1.0B.2-F

A FK composta de Activity foi comprovada apenas em PostgreSQL descartável. TD-ER-004B permanece aberto: divergências históricas precisam diagnóstico/remediação, `Client.tenantId` segue nullable, o schema Prisma e runtime não receberam a relação, e a política XOR continua ativa.

## TD-ER-005 — integração e descendentes de Agenda/Timeline

Os adapters 1.0B.2-G não estão no runtime. AgendaStop e Activity por Agenda ainda exigem prova própria; acessos em routes, IA, automações, ERP, webhooks, health e scripts permanecem não migrados. Multi-parent segue negado e `tenantId` nullable. Resolver por fluxos, sem inferir tenant de seller ou HTTP.

### TD-TENANCY-READ-PILOT — certificar dataset de preview

**Aberto.** O seed de preview prova `tenantId`/memberships sintéticos desde 1.0B.2-J, mas isso não prova estabilidade produtiva nem encerra o piloto. Manter `TENANT_READ_PILOT_ENABLED=false` fora do preview/testes e exigir evidência A×B isolada.

### Observação prolongada do shadow preview
**Aberto.** O dataset sintético e o gate MATCH estão certificados na 1.0B.2-J, mas estabilidade prolongada ainda não autoriza runtime tenant-aware, backfill ou produção.

### Progresso 1.0B.2-K — observação bounded do shadow

O gate proposto cobre 10 ciclos/40 reads sintéticos, correlação interna, isolamento de logs e rerun com volume reutilizado. TD-TENANCY-READ-PILOT permanece aberto: a prova é curta, não produtiva e ainda `NOT_PROVEN` até checks reais verdes. Rate limit, timeout, atraso/retenção de logs e estabilidade temporal produtiva seguem como dívida; não há autorização de runtime, backfill ou cutover.
# TD-TENANT-DATA-READINESS — evidência produtiva e delegate real pendentes

O contrato 1.0B.2-L e o harness sintético não provam dados produtivos, escala, performance nem completude de um futuro adapter Prisma. Permanecem pendentes autorização formal, delegate read-only revisado, execução controlada, evidência por SHA e decisão humana antes de planejar; backfill produtivo e runtime continuam bloqueados.
# TD-PREFLIGHT-GATED-PLAN — operação produtiva permanece bloqueada

O registry em memória prova replay/concorrência somente no processo de teste. Antes de qualquer planejamento formal ainda são necessários storage/lock distribuído revisado, política de expiração, evidência produtiva autorizada, auditoria imutável e provas de escala. READY sintético não representa produção, e plano dry-run não autoriza apply, DML ou ledger produtivo.
# Pendências após a prova 1.0B.2-N

O head `029fab54d32413d0e94308227c0ae591144b7ee7` passou Preview Deploy 31432019343 e Docker
Compose CI 31432019733/job 93597451158, incluindo o gate PostgreSQL do ledger. A prova técnica está
verde (`PREFLIGHT_PLAN_LEDGER_POSTGRES = PASS`); os itens abaixo são limites produtivos, não falhas
da prova descartável.

- **Ledger produtivo continua bloqueado:** DDL/migration Prisma, adapter, papéis, retenção,
  observabilidade e operação HA não foram desenhados/aprovados.
- **Escala não provada:** faltam volume, contenção, WAL, timeout, pool, restore e crash de host.
- **Auditoria de rejeição:** conflito abortado não pode persistir evento na mesma transação;
  qualquer trilha autônoma futura exige desenho próprio sem payload empresarial.

# Pendências do deploy em duas fases e do repositório (07/10/2026)

Registradas após o primeiro cutover sem rebaseline em `b3a662a` (run `37662560135`). Nenhuma foi
corrigida neste registro.

### TD-DEPLOY-RETENTION-DELETE — retenção real de releases

**Aberto.** A retenção só emite relatório (`RELEASE_RETENTION=report`, itens `would_delete`); imagens
de release e tars em `/var/log/gest-o/oci-backups/` crescem sem remoção. A remoção exige PR próprio,
com proteção explícita de imagens em uso, do rollback atual e do `build.tsv` pendente: `docker rmi`
sem `-f` só recusa a última tag de uma imagem em uso e não pode ser a proteção.

### TD-DEPLOY-RELEASE-PIN-LOG — `RELEASE_PIN` duplicado no log do cutover

**Aberto, baixo.** No cutover, `release_pin` roda ao validar a imagem alvo
(`scripts/deploy-production.sh`) e de novo dentro de `release_save`
(`scripts/lib/production-release-artifact.sh`), gerando duas linhas por papel (a segunda com
`state=existing`). O comportamento é idempotente; o ruído atrapalha a leitura da evidência.

### TD-NPM-AUDIT-CRITICAL — vulnerabilidade crítica em dependência

**Aberto.** `npm audit` em 07/10/2026: 17 vulnerabilidades (1 crítica, 7 altas, 9 moderadas).
- **Crítica:** `proxy-addr` 2.0.7, transitiva via `express` 4.22.2 em `apps/api`
  ([GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), IP spoofing via
  IPv6 mapeado em IPv4 em trust subnet).
- **Altas:** `vite` e `tailwindcss` (diretas na web) e as transitivas `braces`, `micromatch`,
  `fast-glob`, `chokidar` e `source-map-js`.
Critério: atualização em PR próprio, com `npm audit` sem críticas e CI verde.

### TD-MAIN-FAILING-TESTS — 4 testes relatados como falhando na `main`

**Aberto, a identificar.** Relatado pelo operador: 4 testes falhando na `main`. Não reproduzido no CI
da `main` em `b3a662a`: Docker Compose CI `37654389601` e Production Deploy Safety `37654389855`
estão verdes, com `# fail 0` em todas as suítes. Identificar quais testes e em que ambiente falham
antes de corrigir.

**CRLF resolvido; restam falhas de ambiente Windows.** O índice já estava todo em LF; o CRLF vinha do
`core.autocrlf=true` do Git for Windows no checkout. O PR `chore/gitattributes-eol-lf` criou o
`.gitattributes` com `eol=lf` (nenhum arquivo precisou ser renormalizado). Em clones locais no Windows
(Git Bash), rodando cada script de `test:production-deploy` e `test:architecture-docs` separadamente:
9 de 13 falhavam antes e 8 de 13 falham depois. Voltou a passar `production-deploy-safety.mjs`. As 8
restantes não são de quebra de linha:

- 7 scripts `.sh` (`production-preflight-mode`, `production-deploy-real-call-graph`,
  `production-env-resolution`, `prepare-canonical-production-env`, `production-build-evidence`,
  `production-release-artifact`, `production-cutover-no-rebuild`): `id -gn` sai com status 1 no Git
  Bash ("cannot find name for group ID"), e o `set -e` encerra o teste.
- `production-rebaseline-safety.mjs`: `mkdir`/`chmod` sem permissão no diretório temporário do Windows.

No CI (Linux) todos passam.

**Decidido: testes de deploy em shell só em Linux/WSL e no CI.** Esses testes verificam dono e
permissões de arquivo no padrão Linux. No Windows nativo (Git Bash) passam 4 de 12 scripts de
`test:production-deploy`, com três causas: `id -gn` não encontra o nome do grupo, `stat -c '%U:%G'`
devolve o grupo como `UNKNOWN` (por isso um fallback para `id -g` não resolveria: o dono esperado não
casaria) e `chmod` falha na pasta temporária. Os testes não foram alterados; a referência é o CI.
Registrado na seção de comandos do `CLAUDE.md`.

### TD-WORKFLOW-SCRIPT-STOP-ELSE — `else` sob `script_stop` no `preview.yml`

**Resolvido.** Os 4 `else` em linha própria do step SSH do `preview.yml` foram reescritos sem
`else`, sem mudar o comportamento de nenhum ramo: a condição vira uma flag avaliada uma vez e dois
`if` sem `else` (site nginx), ou `cmd && X=0 || X="$?"` numa linha seguida de `if` de uma linha
(login, token, `wait`). O `script_stop: true` continua no step. A allowlist de
`scripts/smoke/production-deploy-safety.mjs` foi removida: qualquer `else`/`elif` em linha própria
sob `script_stop` volta a falhar o teste.

Defeito original, o mesmo do VPS Drift Detection (regra em `DEPLOY_GUIDE.md`): quando a condição era
falsa, a checagem que o `drone-ssh` injeta logo depois do `else` encerrava o script com o status não
zero da condição (exit 1 no caso comum), sem executar o ramo. Alcançabilidade antes da correção, só
pela leitura do código (linhas anteriores à correção):

- `cleanup_current_run_on_failure` (trap EXIT, linha ~231, sem nginx anterior): **alcançável** no primeiro preview de uma PR que falha depois de gravar o site nginx; pula a remoção do site, o `nginx -t`/reload e o `rm -rf` do diretório do preview.
- login do shadow proof (linha ~481, `curl` falhou): **alcançável** quando a API não responde (o `curl` sem `-f` só falha por conexão/timeout); pula o marcador de login e o `fail_shadow_proof login`, mas o trap `emergency_shadow_cleanup` ainda faz o rollback do piloto.
- extração do token (linha ~491): **pouco provável**, só com login HTTP 200 sem `accessToken` (regressão de contrato da API); pula `fail_shadow_proof token_extraction`, e o trap ainda faz o rollback.
- `wait` das requisições (linha ~512): **alcançável** quando um `curl` em background falha por conexão/timeout durante os ciclos; pula o registro do exit code e a classificação, e o trap ainda faz o rollback.

### TD-REPO-ROOT-STRAY-FILES — arquivos soltos na raiz

**Removidos da raiz; continuam no histórico.** Os 37 arquivos vazios com nomes de fragmentos de
código (restos de redirecionamento de shell, por exemplo `(`, `void`, `setForm(initialForm)`) e os
dois arquivos com conteúdo, `build-web-log.txt` e `row.status`, que continham identificação de
usuário/host de terminal, foram removidos no PR `chore/remove-root-stray-files`. O `.gitignore`
passou a ignorar `*.log`, `/build-*-log.txt` e `/row.status`. O conteúdo continua acessível no
histórico do git; avaliar tornar o repositório privado.

### TD-BACKUP-UNUSED-CANONICAL-FN — função de backup usada só por teste

**Aberto, baixo.** `backup_validate_canonical_pair_and_freshness`
(`scripts/lib/production-backup-common.sh:18-24`), que exige o par fixo `production.sql.gz`, só é
chamada pelo teste `scripts/smoke/production-backup-canonical-freshness-safety.sh`. Nenhum script,
workflow, `erp-production-recovery.sh` ou o preflight a usa. O comentário da linha 27 ("remains strict
for its existing callers") cita chamadores que não existem mais.

`backup_bind_canonical_pair` **está em uso e deve ficar**: `backup_validate_pair_and_freshness` a
chama (linha 31), e o preparador de backup chama esta em
`scripts/prepare-production-recovery-backup.sh:412` (`PRODUCTION_BACKUP_CANONICAL_PAIR=VALIDATED`
no run `37658861500`).

Critério: remover a função e o comentário em PR futuro, junto com o ajuste do teste, com
`npm run test:production-backup-recovery` e o CI verdes.

### TD-SMOKE-PR18A2-HTTP — `smoke:pr18a2-http` falha com 403

**Resolvido.** O `npm run smoke:pr18a2-http -w @salesforce-pro/api`
(`apps/api/src/scripts/pr18a2HttpRegression.ts`) falhava com `403 !== 200` em
`GET /api/erp/ultrafv3/scheduler/status`. Causa: desde o PR #861 o `authMiddleware` relê o usuário
no banco, e o mock do smoke devolvia só `{ id }`, sem `role` (e sem `email`/`region`). A regra de
permissão da rota não mudou. Corrigido no PR #932, que ajustou o mock do smoke.

### TD-WINDOWS-SHARED-CLEAN-RM — `npm run build` falha no PowerShell

**Aberto, baixo.** No Windows, `npm run build` falha quando chamado pelo PowerShell: o script
`clean` de `packages/shared` usa `rm -rf dist`, e o `cmd.exe` (shell padrão dos scripts npm no
Windows) não tem `rm`. Pelo Git Bash funciona, porque o `rm` está no `PATH`.

### TD-OPPORTUNITY-CLOSE-PATHS — dois caminhos para encerrar oportunidade

**Aberto.** A tela de detalhes (`apps/web/src/pages/OpportunityDetailsPage.tsx`) encerra a
oportunidade por `PUT /opportunities/:id`, e o pipeline (`apps/web/src/pages/OpportunitiesPage.tsx`)
por `PATCH /opportunities/:id/close`. Unificar em um único caminho em PR próprio.

### TD-PRODUCT-SEARCH-MIN-CHARS — busca de produtos a partir de 2 caracteres

**Aberto, decisão atual: manter.** A busca de produtos da oportunidade
(`apps/web/src/pages/OpportunitiesPage.tsx`) só responde a partir de 2 caracteres e busca por
“contém”, então códigos ERP de 1 dígito não são encontrados pelo código.

### TD-PREVIEW-SEED-LEGACY-PRODUCTS — produtos antigos do seed do preview

**Aberto, baixo.** Os 7 produtos antigos do seed do preview (`apps/api/prisma/seedPreview.ts`,
`erpPriceId` “P1001”, filial “01”) nunca aparecem na busca. Remover em ajuste futuro.

### TD-PREVIEW-SEED-LOCAL — seed do preview não roda no compose local

**Aberto, baixo.** Desde o PR #936, o seed do preview exige `DEPLOYMENT_ENV=preview` e não roda mais
no `docker-compose` local (que usa `DEPLOYMENT_ENV=local`).

### TD-CLIENT-SEGMENT-ADDRESS — `segment` do cliente recebe o endereço do ERP

**Aberto.** A sincronização de parceiros do UltraFV3 (`apps/api/src/services/ultraFv3SyncService.ts`)
grava o endereço mapeado no campo `Client.segment`. A busca de clientes (`GET /clients`) também
procura em `segment`. Corrigir o mapeamento (e decidir o que fazer com os valores já gravados) em PR
próprio; não foi alterado no PR da projeção de dados do ERP.

### TD-ERP-PAID-TITLES-STALE — títulos pagos ou ausentes do retorno nunca saem do Client

**Aberto.** A sincronização de `/partnerTitles` (`apps/api/src/services/ultraFv3SyncService.ts`) só
atualiza clientes presentes no retorno do ERP. Um cliente que quitou todos os títulos deixa de vir no
retorno e mantém `partnerTitles`, `openTitlesTotal` e `overdueTitlesTotal` antigos, então o banner de
crédito fica desatualizado. A correção exige saber quando o retorno é um snapshot completo por
vendedor; não foi feita no PR da sincronização financeira por vendedor.

Fase 2 **habilitada** (`PARTNER_TITLE_CLEARING_ENABLED = true` em `ultraFv3SyncService.ts`; regra em
`planPartnerTitleClears`, `ultraFv3FinancialMerge.ts`) após a validação da simulação em produção
(14/10/2026): o cliente fora da carteira do dono saiu como `notInOwnerPortfolio` e os quitados
conferidos no ERP estavam previstos para limpar. A rodada por vendedor grava `partnerTitles` `[]`,
`openTitlesTotal` 0 e `overdueTitlesTotal` 0 só nos clientes planejados (`financialProfile` intacto) e
registra no metrics do ErpSyncRun de `partnerTitles` os clientes limpos (`titleClearing.clearedClients`,
`mode` `"enabled"`), os motivos de bloqueio e `titleClearWritten`. Rollback: reverter o PR que trocou a
flag (volta ao modo simulação). A sincronização com credencial global (`syncPartnerTitles`) continua
sem limpeza.

Retorno completo = envelope do conector (`message` = `"OK"`, `data` em array, sem campo de paginação;
total, se vier, igual ao recebido). Travas: por dono, `returnShrank` quando o número de clientes no
retorno dele cai mais de 50% **e** mais de 5 em relação à rodada bem-sucedida anterior
(`erp.ultrafv3.partnerTitles.sellerCoverage`; sem rodada anterior, valem só as demais condições); por
rodada, teto absoluto de 300 limpezas (`massClearGuard`, bloqueia tudo). O acúmulo de títulos já pagos
não dispara nenhuma das duas.

Carteira do dono na mesma rodada (obrigatória): só limpa se o código do cliente veio no `/partners` do
vendedor dono na mesma rodada, no retorno bruto (antes do filtro `IDN_CLIENTE`). Fora da carteira:
`notInOwnerPortfolio`. `/partners` do dono não rodou, falhou ou teve erro de paginação:
`ownerPortfolioUnproven`. Motivo: na simulação em produção (14/10/2026), um cadastro alterado no ERP
ficou sem vendedor e saiu da carteira do dono. Os títulos em aberto dele deixaram de vir no
`/partnerTitles` de qualquer vendedor, mas no CRM o dono continuou o mesmo (o filtro `IDN_CLIENTE` não
atualiza não-clientes), então o cliente seria limpo por engano. O mesmo vale para um cliente que mude de
carteira ou fique sem vendedor. O botão, o scheduler e a Sincronização Completa passam a carteira do
passo `partners` para o passo `partnerTitles` (`partnerPortfolioRound` em `RunSyncOptions`). Títulos
rodados sem `/partners` na mesma rodada não limpam ninguém. A métrica `titleClearOwnerPortfolios`
registra quantos vendedores tiveram a carteira comprovada na rodada.

Limitação conhecida: o cliente que sai da carteira do dono fica com os títulos antigos (bloqueado, não
limpo) até o dono no CRM ser corrigido ou o cadastro voltar para a carteira dele no ERP.

### TD-ERP-PARTNER-TITLES-NON-SALES — títulos que não são de venda entram no banner de risco

**Resolvido no código, aguardando deploy.** O `/partnerTitles` traz, além das receitas de venda, outros
tipos em `DSCRECEITA` (devoluções de adiantamento a cliente, funcionário e fornecedores, REEMBOLSO,
PRESTAÇÃO DE SERVIÇOS, EMPRÉSTIMO PARTICULAR), que entravam no banner de crédito como dívida do cliente.

Decisão de negócio: só contam como título a receber do cliente `VENDAS`, `VENDA ENTREGA FUTURA` e
`VENDA AMBULANTE`, comparados de forma exata depois de normalizar (maiúsculas, sem acento, espaços
aparados e colapsados; sem prefixo ou "contém"). `DSCRECEITA` ausente ou vazio conta (fail-open). Qualquer
outro tipo preenchido deixa de ser gravado em `partnerTitles` e fica fora de `openTitlesTotal`,
`overdueTitlesTotal`, do atraso calculado pelos títulos, do banner e da tabela da tela.

Regra em `isSalesReceivableTitle` (`ultraFv3FinancialMerge.ts`), aplicada só na gravação, nos dois
caminhos de `ultraFv3SyncService.ts` (todos os vendedores e o legado `syncPartnerTitles`). Busca,
cobertura, completude, `planPartnerTitleClears`, travas e o cache bruto em `appConfig` continuam com o
retorno bruto: cliente que veio só com títulos que não são de venda conta como presente e é gravado com
`[]` e totais 0. Sem filtro na leitura. O Histórico do run de `partnerTitles` registra
`nonSalesTitlesDropped`, `nonSalesTitlesByType` (tipo normalizado → contagem, sem códigos de cliente) e
`titlesWithoutType`.

Dado gravado só se corrige na próxima sincronização de títulos que inclua o cliente. Risco: se o ERP
renomear um tipo de venda, os títulos dele somem do banner sem erro; conferir `nonSalesTitlesByType` no
Histórico. Para reverter: reverter o PR; a sincronização seguinte volta a gravar todos os tipos (sem
migration nem mudança de schema).

### TD-CLIENT-COLLECTION-RULE — cliente em cobrança fora das sugestões de venda

**Resolvido no código, aguardando deploy (decisão da diretoria de 22/10/2026).** Cliente com qualquer título de
venda vencido há mais de 30 dias (dia de Brasília), de qualquer valor, está "em cobrança". A regra fica em
`packages/shared/src/clientCollection.ts` (`COLLECTION_OVERDUE_DAYS`, `isClientInCollection`); os dias são os do
"Maior atraso em aberto" (`buildClientDelayMetrics`), só com títulos `isSalesReceivableTitle`, em
`apps/api/src/services/clientCollection.ts`. Sem coluna nova: lê `partnerTitles` só de quem tem `openTitlesTotal` ou
`overdueTitlesTotal` > 0.

Sai de: prioridades do dia e "Minha IA Comercial", planejamento semanal (e encaixes da Agenda), Assistente
Comercial (prioridades, sem comprar, esfriando, primeira venda, oportunidades por prioridade, ações sugeridas,
audiência de campanha), IA Comercial do gestor, alerta de esfriando e automação de inativos recentes (a simulação
mostra "Em cobrança (fora)"). Sugestão inteligente e resumo do cliente recomendam só apoiar a regularização; a IA
recebe só a situação "Em cobrança". Lista em `/clientes?cobranca=1` e contagem na Central do Dia.

Pendente: a mensagem de WhatsApp do assistente, a inteligência da timeline e a mensagem de venda da oportunidade
ainda usam a abordagem da carteira (podem sugerir reativação para cliente em cobrança). O peso de ler
`partnerTitles` não foi medido em produção; se pesar, a alternativa é gravar o vencimento mais antigo na
sincronização (exige migration e aprovação).

### TD-SYSTEM-TIMELINE-NOTES — registros de sistema viravam "observação recente"

**Resolvido no código, aguardando deploy.** A sincronização UltraFV3 (`createUltraFv3ClientAuditEvent` em
`ultraFv3SyncService.ts`), os saneamentos e a limpeza da carteira gravam auditoria na `TimelineEvent` com
`type=status`, sem oportunidade e com o vendedor dono em `ownerSellerId` (não há autor de sistema). A Sugestão
inteligente pegava o evento mais novo do cliente e mostrava esse texto como "Observação recente". Critério estrutural
em `apps/api/src/services/sellerObservation.ts`: observação do vendedor é só `type=comentario` com oportunidade (o
único formato que o usuário grava). Aplicado na observação da Sugestão inteligente, no contexto do cliente enviado à
IA (inclui a mensagem de WhatsApp do assistente) e no insight da oportunidade. Nada foi apagado no banco. O Resumo
automático do cliente passou a usar a situação oficial da carteira e a mesma recomendação da Sugestão inteligente.

Pendente: a timeline do cliente e a inteligência da timeline continuam mostrando os registros de sistema, porque eles
têm o mesmo formato dos eventos de agenda e visita (`status` sem oportunidade); separar exige marcar a origem do
evento (coluna nova, migration e aprovação). As prioridades do dia ainda leem qualquer evento da oportunidade como
observação. A atividade criada pela automação de inativos (`Contato automático: …`) não tem marcação de origem e
continua entrando como observação no Resumo automático.

### TD-AGENDA-WEEKLY-PLAN-TODAY — planejamento semanal sugeria dias passados e agrupava ligação por cidade

**Resolvido no código, aguardando deploy.** `planningIntelligenceService.ts` sugere só de max(início da semana,
hoje pela data de Brasília) em diante; follow-up e atividade vencidos ficam presos em hoje (antes, na segunda); dias
que já passaram mostram só os compromissos, agrupados pela data de Brasília. Só visita e compromisso presencial
(`roteiro_visita`, `reuniao_presencial`) definem a cidade do dia e só visita busca o dia da mesma cidade; ligação,
WhatsApp, follow-up, proposta e revisão não. Textos da tela do planejamento e da Agenda Inteligente em português
("Sugestão do sistema"/"Sugestão da IA", carga, período, confiança), sem "determinístico", "Fallback" e "Haversine".

Pendente: semana inteira no passado deixa todas as sugestões em `unallocatedPriorities` e a carga aparece como "Carga
alta" (`overloaded`). Prazos de follow-up e atividade continuam com a data UTC (`dateOnly`). A chave dos cards
(`data-clientId`) se repete quando o mesmo cliente tem duas ações no dia (aviso do React). O cabeçalho mostra as datas
em ISO (`2026-10-19`). O aviso fixo "Cache em memória…" segue em `warnings` (não aparece na tela). Proximidade por mapa
fica para outro PR.

### TD-AGENDA-WEEKLY-PLAN-ACTIONS — sugestão do planejamento semanal sem ação

**Resolvido no código, aguardando deploy.** Cada sugestão do planejamento semanal tem "Agendar", "Registrar" e
"Abrir" (`WeeklyCommercialPlan.tsx`, funções em `weeklyPlanActions.ts`). "Agendar" cria o compromisso pela rota que a
Agenda já usa (`POST /agenda/events`) no dia da sugestão, às 9h (manhã ou sem período) ou 14h (tarde) de Brasília;
visita entra como `reuniao_presencial` e o resto como `followup`. "Registrar" abre a Nova atividade em Atividades
(`/atividades?open=create&…`, o mesmo caminho da Agenda) com tipo, cliente, oportunidade, data e "Atividade já
realizada" marcada. "Abrir" vai para a oportunidade ou, sem ela, para o cliente. Gerente e diretor criam no nome do
vendedor do planejamento (`resolveOwnerId`); vendedor só no próprio. Sem migration: o vínculo é cliente + oportunidade
na semana. `planningIntelligenceService.ts` não sugere cliente que já tem compromisso na semana (de segunda a sexta,
inclusive parada de roteiro) ou atividade criada desde segunda, com a mesma oportunidade quando os dois têm uma; a
atividade pendente não esconde a própria sugestão "Concluir atividade".

Pendente: `POST /agenda/events` não confere se o cliente e a oportunidade são do vendedor (já era assim). Não existe
tipo de compromisso "ligação" (`AgendaEventType`), por isso ligação, WhatsApp, proposta e revisão viram `followup`.
Qualquer compromisso ou atividade do cliente na semana, mesmo criado fora do planejamento, tira o cliente das
sugestões. A atividade salva pela tela de Atividades grava o vencimento à meia-noite UTC (21h do dia anterior em
Brasília). Depois de "Agendar", os totais do topo só se atualizam ao recarregar. A Agenda Inteligente mostra o horário
do compromisso em UTC (14h aparece 17:00). WhatsApp fica para a integração de WhatsApp.

### TD-ERP-DUE-DATE-ISO-DEPENDENCY — vencimento dos títulos lido com `new Date()` na sincronização

**Aberto, baixo.** Em consulta somente leitura à produção (12/10/2026), 100% dos `DATA_VENCIMENTO`
gravados em `Client.partnerTitles` estavam em ISO com hora (ex.: `2025-12-10T03:00:00.000Z`). O
`isTitleOverdue` da sincronização (`apps/api/src/services/ultraFv3SyncService.ts`), que calcula o
`overdueTitlesTotal` do banner de crédito, e o status "vencido" de cada linha na tela do cliente
(`apps/web/src/pages/ClientDetailsPage.tsx`) usam `new Date(String(DATA_VENCIMENTO))` e dependem
desse formato: `dd/mm/aaaa` seria lido como mês/dia e `dd.mm.aaaa` seria inválido. O atraso em aberto
calculado pela API (`parseErpDueDay` em `clientErpProjection.ts`) já aceita os três formatos. Se o ERP
mudar o formato, trocar os dois pontos acima por `parseErpDueDay`.

### TD-ERP-REFERENCE-SELLER-ALPHABETICAL — vendedor de referência escolhido por ordem alfabética

**Aberto.** Sem credencial global, `resolveReferenceCredentials` (`ultraFv3SyncService.ts`) e o status do
scheduler (`erpSyncScheduler.ts`) usam o primeiro vendedor ativo com Login FV3 em ordem alfabética
para os catálogos. Não há configuração explícita: cadastrar ou desativar um vendedor pode trocar a
credencial usada sem aviso.

### TD-ERP-SYNC-RUN-ORPHAN-RUNNING — ErpSyncRun interrompido fica como `running` para sempre

**Aberto.** Se a API reinicia no meio de uma sincronização (por exemplo, num cutover), o `ErpSyncRun`
em andamento nunca é finalizado e aparece como `running` no Histórico indefinidamente. Isso vale para
a Sincronização Completa (`syncAll`), o botão de todos os vendedores (`sellerPortfolio`), o scheduler
(`automatic`) e os runs por escopo e vendedor. Os locks expiram pelo TTL e liberam novas execuções,
mas o run órfão continua visível e pode confundir a UI e a leitura do Histórico. Não corrigido no PR
da sincronização financeira por vendedor.

### TD-ERP-CREDIT-FIELDS — campos de limite, bloqueio e crédito duvidoso não confirmados

**Aberto.** O `creditAlert` da API (`apps/api/src/services/clientErpProjection.ts`) usa só atraso
médio, maior atraso em aberto, cheques devolvidos e `overdueTitlesTotal`. Os nomes reais dos campos
de limite de crédito, bloqueio e crédito duvidoso no `/financialProfiles` do UltraFV3 não foram
confirmados; incluí-los no alerta e na lista de permitidos só depois de confirmar com o ERP.

### TD-WINDOWS-URL-PATHNAME — scripts que montam caminho com `URL.pathname` falham no Windows

**Aberto, baixo.** `apps/api/src/scripts/commercialAutomationsSmoke.ts` (`smoke:commercial-automations`)
usa `new URL(..., import.meta.url).pathname` e, no Windows nativo, abre `C:\C:\...` (ENOENT). O
`verify-brand-assets` do build do web mostra o mesmo padrão nos avisos (`/C:/...`), sem falhar o
build. Em Linux e no CI funciona. Trocar por `fileURLToPath` em PR próprio.

### TD-ERP-REFERENCE-EMPTY-CACHE-OPEN — revalidação de referências libera o envio com cache vazio

**Aberto.** `assertReferenceCode` (`apps/api/src/services/erpOrderService.ts`) só rejeita forma de
pagamento, condição de recebimento ou operação não liberada quando o cache sincronizado
(`erp.ultrafv3.paymentMethods`, `erp.ultrafv3.receivingConditions`, `erp.ultrafv3.operations`) existe e
tem linhas. Com o cache ausente ou vazio, a revalidação retorna sem bloquear e o pedido segue para o
ERP com o código informado. A listagem da tela fica vazia nesse caso, mas um envio direto pela API passa.
Mantido assim no PR #949; tornar fail-closed em PR próprio.

### TD-ERP-AVERAGE-DELAY-TOLERANCE — média de atraso do ERP até 4 dias não gera aviso de crédito

**Decisão de negócio, registrada.** Vencimento em sábado, domingo ou feriado é liquidado no próximo
dia útil, e o `DIAS_MEDIAATRASO` do ERP fica entre 1 e 4 dias para clientes que pagam em dia. O
`creditAlert` (`buildClientCreditAlert` em `apps/api/src/services/clientErpProjection.ts`) só usa a
média como motivo quando ela passa de `ERP_AVERAGE_DELAY_TOLERANCE_DAYS = 4` (4 não gera; 4,1 e 5
geram). Títulos vencidos, maior atraso em aberto pelos títulos e cheques devolvidos seguem sem
tolerância. A média continua visível no Perfil Financeiro. Para reverter, voltar a constante para `0`
(regra anterior: qualquer média acima de 0 gera atenção) e ajustar o teste de tolerância em
`clientErpProjection.test.ts`.

### TD-PLATFORM-HEALTH-PARENT-RUN — Saúde perdia a execução-pai fora das 100 linhas recentes

**Corrigido na branch `fix/platform-health-parent-run`.** A Saúde da Plataforma lia só as 100 linhas
mais recentes de `ErpSyncRun` e procurava a execução-pai entre elas. Cada rodada grava dezenas de
etapas, então a execução-pai saía da lista e a tela mostrava "Sem registro", "Sem execução-pai" e
`-1` em "Sincronização parada". Agora `loadPlatformHealthRuns` (`platformHealthService.ts`) busca as
execuções-pai direto, pelo mesmo critério de `platformHealthProjection.ts` (`syncAll` manual e
`automatic` do scheduler). "Sincronização parada" conta a partir da última execução-pai com sucesso,
só alerta dentro da janela do scheduler e nunca mostra número negativo. O "Executar agora" passou a gravar `metrics.origin = "run_now"` e não comprova
mais a execução automática na Saúde.

Fica em aberto:
- A Integração ERP (`getErpAutomaticSyncState` em `apps/api/src/jobs/erpSyncScheduler.ts`) ainda conta
  o "Executar agora" como última execução do scheduler.
- Execuções do "Executar agora" gravadas antes desta correção não têm `origin` e continuam contando
  como automáticas até a próxima rodada real do scheduler.

### TD-ERP-OPEN-ORDER-ERRORS — card "Erro" e banner ERP contavam erros já superados

**Corrigido na branch `fix/erp-open-order-errors`.** O card "Erro" da Integração ERP, o banner
"Alerta operacional ERP" e o 207 de `GET /erp/ultrafv3/healthcheck` contavam toda tentativa
`ErpOrderSync` com `status = error`. Um reenvio cria outra tentativa e a antiga fica `error` para
sempre, então o alerta não apagava. Agora contam só oportunidades com erro em aberto: tentativa
`error` sem resolução manual e sem tentativa `sent` criada depois na mesma oportunidade. A regra fica
em `findOpenErpOrderErrorOpportunityIds` (`packages/shared`), e `getErpOrderOperationalSummary`
(`erpOrderOperationalSummary.ts`) também alimenta os cards "Pedidos sincronizados" e "Pedidos com
erro" da Saúde. O total de tentativas com erro aparece como "N no histórico".

Fica em aberto:
- A conferência de status (`syncErpOrderStatuses`) consulta de hora em hora todas as tentativas
  `sent/pending/error` sem resolução manual, sem limite de data. Tentativas recusadas pelo ERP no
  POST nunca são localizadas e somam em `nonCriticalOrderStatusErrors` a cada rodada. (Recusas
  definitivas saem da conferência em TD-ERP-ORDER-STATUS-UNMATCHED-WRITES.)
- `GET /erp/ultrafv3/diagnostics` ainda expõe `errorOrders` (histórico) no nível de cima.

### TD-ERP-ORDER-STATUS-UNMATCHED-WRITES — conferência de status gravava situação sem pedido casado

**Corrigido na branch `fix/order-status-no-unmatched-writes`.** Entre o PR #856 (que passou a usar
`extractOperationalStatus(response)`) e o commit `1d8ce315`, a conferência gravava em
`operationalStatusRaw`/`operationalOrderStatus` a situação do primeiro registro da resposta do
`/orderStatus`, mesmo com outcome `unknown`, e criava evento "situação atualizada" na timeline.
Tentativas `error` recusadas pelo ERP no POST ganharam assim uma situação falsa. Agora:
- só há gravação de situação, `orderStatus`, histórico e timeline com registro do ERP casado e outcome
  diferente de `unknown` (`buildErpOrderStatusReconciliation`). Com `unknown` grava só a conferência;
- tentativa `error` com recusa definitiva no POST não é mais consultada. A de resultado incerto
  (timeout/rede, mesma regra do bloqueio de reenvio) é consultada e casada só pela chave de
  importação (`planErpOrderStatusLookup`);
- recusa confirmada não sobrescreve mais o `erpResponse` original; o resultado fica em
  `lastStatusPayload` e em `syncErrors` (que o bloqueio de reenvio já lia);
- o aviso da rodada separa "não localizado(s) no ERP" de "falha na chamada ao ERP"
  (`orderStatusNotFound`, `orderStatusCallFailures`; `nonCriticalOrderStatusErrors` segue como soma).

Fica em aberto:
- **Limpeza de dados (PR separado, com aprovação):** tentativas `error` que ficaram com situação falsa
  (`operationalStatusRaw`/`operationalOrderStatus`) e os eventos "Pedido ERP …: situação atualizada"
  criados na rodada de 08/09/2026. Esta correção impede novos casos, mas não apaga os antigos.
- **Casamento pelo número em tentativas `sent`:** o ERP aceita `NUM_PEDIDO` repetido e há pedidos
  antigos (antes da sequência 9000xx) com o mesmo número em várias oportunidades.
  `classifyUltraFv3OrderLookup` aceita o primeiro registro com a mesma chave **ou** o mesmo número,
  inclusive dentro da resposta da consulta pela chave. Proposta: dar preferência ao registro com a
  chave de importação. Quando o casamento vier só pelo número, exigir registro único com `PARCEIRO` e
  `VENDEDOR` iguais aos do `payloadSent`. Com mais de um registro ou divergência, outcome `unknown`, sem
  gravar situação.
- **Cliente criado no CRM com código inexistente no ERP:** o POST /orders envia `Client.code` como
  `PARCEIRO` e o ERP recusa por FK. Proposta (PR separado): bloquear o envio com mensagem clara quando
  o código do cliente não existir no cadastro de parceiros do ERP.
- Uma conferência `unknown` grava em `syncErrors` o registro da conferência no lugar da falha original.
  Com isso, uma tentativa `error` por timeout deixa de parecer incerta para o bloqueio de reenvio
  (`isUncertainErpOrderFailure` lê `syncErrors` antes de `erpResponse`), apesar da mensagem
  "reenvio permanece bloqueado". O comportamento já existia e não foi alterado aqui.
- A consulta manual `POST /orders/:id/status-consultation` responde 502 ("falhou") quando o pedido só
  não foi localizado (`errorCount` soma não localizado e falha de chamada).

### TD-DATE-FILTERS-BRASILIA — filtros de período fora do dia de Brasília

**Corrigido na branch `fix/inclusive-brasilia-date-filters` (PR #958).** "De D1 até D2" passou a ser
de D1 00:00 ao fim de D2 em Brasília (UTC-3 fixo) em Oportunidades, Relatórios (encerradas), Pedidos,
Dashboard, scores mensais, consistência, destaques semanais, contagem mensal de atividades, Territórios
e auditoria da Saúde. Instantes usam `brazilDayRange`; data pura gravada como meia-noite UTC
(`proposalDate`, `expectedCloseDate`) usa `calendarDayRange` (`apps/api/src/utils/dateRange.ts`,
`periodFilters.ts`). Na web, mês e dia padrão vêm de `apps/web/src/lib/brazilDate.ts`.

Fica em aberto:
- **`Activity.date`/`Activity.dueDate` têm semântica mista (decisão de negócio):** atividade executada
  grava o instante real; as demais gravam a data escolhida como meia-noite UTC. Nenhum recorte único
  acerta os dois. Afeta `/activities?month`, `/activity-kpis`, `weekly-missions`, `weekly-visits`,
  `weekly-discipline`, `planned-vs-realized`, `discipline-ranking`, a parte de execução do
  `commercial-score` e `getActivityCountByTypeInMonth`. Antes de corrigir, decidir se o campo é dia ou
  instante e normalizar os dados.
- "Atrasada" (`getUtcTodayStart`, também o `now` das prioridades do dia) usa o dia UTC: das 21h à
  meia-noite de Brasília já conta o dia seguinte. No plano comercial de IA (`planningIntelligenceService`)
  a semana padrão já segue o dia de Brasília, mas a distribuição por dia (`dateOnly`) ainda usa o dia UTC.
- Datas padrão de cadastro na web ainda usam `toISOString()` (nova atividade pelo atalho móvel, entrega
  prevista do pedido em `OpportunityDetailsPage`, data de entrada da oportunidade rápida na Agenda).
- Código morto: `getWeekRangeFromStart` (`crudRoutes.ts`) e `startOfDay`/`endOfDay` em
  `conversationalCrmService.ts`.

### TD-ERP-REJECTED-ATTEMPTS-AS-ORDERS — tentativas recusadas pelo ERP contavam como pedido

**Corrigido na branch `fix/orders-exclude-rejected-attempts`.** Pedido válido = tentativa
`ErpOrderSync` aceita pelo ERP (`status = sent`), regra única em `isValidErpOrder` /
`VALID_ERP_ORDER_SYNC_STATUS` (`packages/shared`). Tentativas `error` e `pending` ficam fora de
"Sincronizados" na Integração ERP e na Saúde (`getErpOrderOperationalSummary`) e do ganho efetivo
usado por dashboard, relatórios, metas e oportunidade (`effectiveWonContribution`). Na tela Pedidos e
em "Pedidos do cliente" (`summarizeOrders`), `pending` entra em "Pedidos" e "Valor total" (card
"Aguardando") e `error` fica fora, só no card "Recusados pelo ERP". A tentativa `error` aparece como
"Recusado pelo ERP" com a mensagem curta do erro, sem situação nem quantidades do ERP.

Fica em aberto:
- 5 tentativas `error` em produção ainda guardam situação FINALIZADO falsa no banco (limpeza em PR
  próprio). A tela e os totais já as ignoram.
- `erpClientAuditService` (scripts de auditoria/reparo de cliente) e a contagem de dependências do
  desligamento de vendedor contam todas as tentativas; mantidos de propósito (registros, não pedidos).

### TD-CLIENT-CODE-CRM-TYPED — código do cliente digitado ou importado no CRM

**Corrigido na branch `fix/client-code-erp-only`.** `Client.code` passa a vir só da sincronização
de parceiros do ERP. `POST`/`PUT /clients` recusam `code` com 400 (sem descarte silencioso); o
cadastro de novo cliente não mostra o campo e a edição o mostra só como leitura. A importação de
planilha não grava mais `code` nem `erpUpdatedAt` (o código da planilha só serve para achar cliente
existente). Pedido ERP de cliente sem código responde 422 antes de ler tentativas, criar tentativa ou
reservar número, e os botões "Gerar/Reenviar pedido ERP" ficam desabilitados com a orientação.
Teste: `test:client-code-erp-only` (API e web), fora do CI como os demais testes HTTP de rota.

Fica em aberto:
- Clientes que já têm código digitado ou importado (ver consulta read-only fora do repo): podem
  coincidir com parceiro real do ERP. Revisão e limpeza em PR próprio.
- Cliente criado no CRM sem CPF/CNPJ não é ligado pelo Partner Sync quando o parceiro do ERP tem
  documento: o sync cria outro cliente e o do CRM fica sem código (pedido bloqueado). Proposta:
  documento obrigatório no cadastro do CRM e fluxo de vínculo/fusão para os existentes.
- A importação ainda grava `lastPurchaseDate` e `lastPurchaseValue` da planilha (dados de
  faturamento que o sync não grava hoje); decidir se passam a ser só do ERP.
- `PUT /companies/:id` e `/clients/diagnostics/merge-duplicates` não gravam código novo (o primeiro
  descarta `code` pelo schema; o segundo só marca `__MERGED__` no duplicado arquivado).
