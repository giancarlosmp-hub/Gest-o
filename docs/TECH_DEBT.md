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
