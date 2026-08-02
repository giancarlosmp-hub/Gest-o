# Enterprise Readiness — baseline oficial

**Baseline:** Sprint 0.1 — Auditoria Enterprise
**Estado:** 🔵 PR
**Escopo probatório:** inspeção documental/estática inicialmente realizada no `HEAD e2a41a7`, depois
reconciliada com evidências operacionais da VPS e validação funcional humana de 01/08/2026. Esta
baseline **não declara o Gest-o Enterprise-ready**, não fecha incidentes e não transforma interface
visível em prova de todos os componentes internos.

**Nota da Sprint 0.4:** o script read-only e o procedimento de restore autorizado melhoram a
preparação de evidência, mas não mudam nenhuma classificação. Somente execução revisada por SHA e
ensaio com cópia aprovada podem alterar a evidência futura.

## Método e escala

| Estado | Critério objetivo |
|---|---|
| 🟢 Comprovado | Evidência versionada suficiente para o requisito estritamente avaliado. Não implica execução em produção. |
| 🟡 Parcialmente comprovado | Há mecanismos verificáveis, mas falta parte do requisito ou evidência de execução. |
| 🔴 Crítico ou não conforme | Evidência objetiva de exposição/não conformidade ou gate crítico aberto. |
| ⚪ Não comprovado | A fonte não permite concluir; não equivale a afirmar que não existe fora do repositório. |
| ➖ Não aplicável | O requisito não incide sobre esta auditoria, com justificativa explícita. |

Cada linha é um requisito auditável. Caminhos e linhas são links para a evidência versionada. “Não
encontrado na busca” descreve apenas o checkout. Arquivo, teste e runbook provam que o artefato existe,
não que foi executado em produção.

## Matriz por dimensão

| Dimensão | Requisito | Estado | Evidência | Lacuna | Risco | Próxima ação | Severidade | Dependência | Responsável sugerido | Sprint sugerida |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. Produto e visão comercial | Proposta, público, módulos e prioridade comercial rastreáveis | 🟡 Parcialmente comprovado | [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md), seção 3; [`product/README.md`](product/README.md) | O mestre inventaria módulos, mas não há ICP, proposta de valor validada, catálogo comercial ou métricas de adoção versionados. | Venda sem escopo e expectativa controlados. | Aprovar visão de produto, ICP, resultados mensuráveis e limites da oferta. | Alta | Fechamento dos P0 | Product Manager / Produto SaaS | Épico 5 |
| 2. Arquitetura | Visão de componentes, limites e decisões duradouras | 🟡 Parcialmente comprovado | [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md#2-arquitetura-ponta-a-ponta); [`TENANCY_ASSESSMENT.md`](TENANCY_ASSESSMENT.md); [`adr/README.md`](adr/README.md) | A Sprint 0.6 inventaria componentes e dependências para tenancy e a ADR 003 propõe a boundary futura; contratos gerais, ownership completo e diagramas dos demais domínios continuam pendentes. | Acoplamento e mudanças incompatíveis sem análise de impacto. | Aceitar a ADR 003 e estender o catálogo verificável aos demais domínios. | Alta | Inventário e ADRs vigentes | Arquiteto de Software | Épico 3 |
| 3. Segurança | Hardening web, segredos e superfície de diagnóstico seguros | 🔴 Crítico ou não conforme | `helmet`, CORS allowlist e rate limit em [`apps/api/src/app.ts`](../apps/api/src/app.ts); Sprint 0.2 remove `/debug/admin` e adiciona teste negativo, mesclados na PR #766 | A correção requer deploy/validação por SHA; faltam threat model, SAST/DAST, gestão de vulnerabilidades e hardening comprovado da VPS. | Superfície diagnóstica ou vulnerabilidades ainda não inventariadas. | Validar TD-ER-001 após deploy e estabelecer baseline completa. | Crítica | Gate de segurança; TD-ER-001 | Segurança | Épico 1 |
| 4. Identidade, autenticação e autorização | Sessões revogáveis, RBAC completo e autorização negativa | 🟡 Parcialmente comprovado | JWT e refresh cookie em [`apps/api/src/controllers/authController.ts`](../apps/api/src/controllers/authController.ts); RBAC em [`apps/api/src/middlewares/authorize.ts`](../apps/api/src/middlewares/authorize.ts); rate limit em [`apps/api/src/middlewares/rateLimit.ts`](../apps/api/src/middlewares/rateLimit.ts) | Refresh token não tem rotação/revogação persistida comprovada; logout apenas limpa cookie; não há MFA/SSO nem suíte abrangente de autorização negativa. | Sessão roubada permanece válida e privilégios podem regredir sem detecção. | Definir política de sessão e matriz RBAC; testar negações por rota e objeto. | Alta | Segurança | Segurança / QA | Épico 2 |
| 5. Privacidade e LGPD | Inventário de dados, base legal, direitos, retenção e logs minimizados | 🔴 Crítico ou não conforme | Sprint 0.2 substitui logs de login por eventos minimizados, mesclados na PR #766; sanitização em [`apps/api/src/utils/logger.ts`](../apps/api/src/utils/logger.ts) | A correção requer deploy/validação; faltam ROPA, bases legais, DPO, retenção global, DSAR e expurgo. | Exposição residual e incapacidade de atender direitos do titular. | Validar TD-ER-002 após deploy e aprovar programa LGPD. | Crítica | TD-ER-002; gate de segurança | Segurança / Jurídico-Privacidade | Épico 1 |
| 6. Banco de dados | Schema versionado, integridade e migrations reproduzíveis | 🟡 Parcialmente comprovado | Schema, índices e constraints em [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma); ADR em [`adr/002-runtime-migration-authority-separation.md`](adr/002-runtime-migration-authority-separation.md); operação de 01/08 confirmou `applied.tsv`, checksum, pós-diff gerenciado vazio, cinco tabelas, sete enums, duas colunas de `Contact` e oito `incident_*` preservadas | Schema/apply estão comprovados; faltam ledger histórico confiável, restore isolado e revisão central das queries raw. | Drift histórico, recuperação não demonstrada e SQL crítico sem governança uniforme. | Baselinear o histórico de migrations, provar restore isolado e revisar raw SQL/constraints. | Crítica | INC-PROD-2026-07; restore | DBA PostgreSQL | Épico 1 |
| 7. Backup e restauração | Backup íntegro, protegido e restauração ensaiada | 🟡 Parcialmente comprovado, condicionado ao check Docker da PR | Criação/rotação em [`ops/backup.md`](ops/backup.md); harness PostgreSQL 16, checksum, catálogo, pós-condições e proposta RPO/RTO em [`ops/backup-restore-readiness.md`](ops/backup-restore-readiness.md) | Evidência sintética não comprova dump/restore de produção; faltam execução operacional aprovada, criptografia, off-site e aprovação humana de RPO/RTO. | Perda de dados ou backup inutilizável durante incidente. | Aprovar check Docker e executar ensaio autorizado; aprovar objetivos, proteção e runbook operacional. | Crítica | TD-ER-003; INC-PROD-2026-07 | DBA / DevOps | Épico 1 |
| 8. Deploy e rollback | Publicação identificável, controlada e reversível | 🟡 Parcialmente comprovado | Workflow em [`.github/workflows/deploy-production.yml`](../.github/workflows/deploy-production.yml); runbook em [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md); cutover local de 01/08 concluído para `a08a626`, containers API/WEB iniciados e validação funcional humana aprovada | Deploy/cutover local foram executados; rollback pós-cutover não foi executado e a confirmação pública completa por `/health/version`/`build-info.json` pode não ter sido preservada. | Divergência de versão pública ou reversão não demonstrada em falha real. | Consolidar prova pública por SHA, monitorar estabilidade e executar ensaio de rollback em janela aprovada. | Crítica | INC-PROD-2026-07 | DevOps | Épico 1 |
| 9. Observabilidade e resposta a incidentes | Métricas, alertas, SLOs, runbooks e resposta auditável | 🟡 Parcialmente comprovado | [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md); logs estruturados em [`apps/api/src/utils/logger.ts`](../apps/api/src/utils/logger.ts); incidentes em [`incidents/`](incidents/) | Painel existe, porém adaptadores de alerta e SLOs são plano; não há traces, on-call, retenção central ou exercício de resposta comprovados. | Falhas podem ser percebidas tarde e sem contexto preservado. | Definir SLIs/SLOs, alertas acionáveis, responsáveis, retenção e game day. | Alta | P0 encerrados | Observabilidade / Operação | Épico 3 |
| 10. Qualidade e testes | Pirâmide automatizada com evidência por revisão e ambiente | 🟡 Parcialmente comprovado | Testes Node em `apps/api/src/**/*.test.ts`; smoke Compose em [`.github/workflows/docker-compose-ci.yml`](../.github/workflows/docker-compose-ci.yml); checklists manuais em [`manual-test-checklist.md`](manual-test-checklist.md) | Não foi encontrada suíte E2E browser, cobertura/threshold, testes de acessibilidade ou evidência desses testes na produção; login no CI usa diagnóstico permissivo durante coleta. | Regressões críticas e de jornada escapam para release. | Formalizar matriz de testes, E2E de fluxos críticos, autorização negativa e evidência por SHA. | Alta | Ambientes representativos | QA | Épico 3 |
| 11. Performance e escalabilidade | Capacidade, limites, concorrência e metas verificadas | ⚪ Não comprovado | Limites/cache descritos em [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md); locks/scheduler em [`apps/api/src/jobs/erpSyncScheduler.ts`](../apps/api/src/jobs/erpSyncScheduler.ts) | Não foram encontrados SLO de latência/capacidade, testes de carga, sizing ou resultados de concorrência. | Saturação e custo imprevisíveis com crescimento. | Definir workload, metas e teste reprodutível antes de alegar escala. | Alta | Observabilidade e arquitetura | Plataforma / Performance | Épico 3 |
| 12. Multiempresa e isolamento | Isolamento integral de dados, jobs, cache e integrações por empresa | 🔴 Crítico ou não conforme | [`TENANCY_ASSESSMENT.md`](TENANCY_ASSESSMENT.md); `tenantId` aparece somente em quatro models de Communications no [`schema.prisma`](../apps/api/prisma/schema.prisma); [ADR 003 proposta](adr/003-shared-schema-tenant-boundary.md) | 27 models, APIs, raw SQL, JWT, caches, jobs e ERP foram classificados; não existe boundary implementada nem prova negativa cross-tenant. | Vazamento entre empresas se a plataforma for comercializada como multiempresa. | Manter alegação bloqueada; aceitar a ADR, executar roadmap 1.0A–1.0F e provar isolamento ponta a ponta antes de GA. | Crítica | Arquitetura, identidade, segurança, DBA e operação | Arquitetura / Segurança | Épico 4 |
| 13. Integrações e API | Contratos, autenticação, idempotência, versionamento e quotas | 🟡 Parcialmente comprovado | UltraFV3 documentado em [`erp-ultrafv3-integration-technical.md`](erp-ultrafv3-integration-technical.md); Communications em [`communications/secure-omnichannel-foundation.md`](communications/secure-omnichannel-foundation.md); IA em [`investigations/ollama-ai-integration-diagnosis.md`](investigations/ollama-ai-integration-diagnosis.md) | Não há catálogo/OpenAPI, política de versão/depreciação, SLA de providers ou prova operacional completa de UltraFV3, WhatsApp e IA. | Quebra de consumidores, duplicidade e dependência externa não controlada. | Inventariar contratos, owners, idempotência, quotas e testes de falha por integração. | Alta | Incidentes UltraFV3; segurança | Arquiteto de Integrações | Épico 2 |
| 14. UI/UX e acessibilidade | Jornadas responsivas e conformidade de acessibilidade testada | 🟡 Parcialmente comprovado | Breakpoints e atributos ARIA em `apps/web/src`; descrição responsiva em [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md) | Não há auditoria WCAG, testes automatizados, matriz de dispositivos, navegação por teclado ou pesquisa de usabilidade comprovadas. | Exclusão de usuários, barreira comercial e regressões móveis. | Definir nível WCAG alvo e executar auditoria/testes de jornadas críticas. | Alta | Design system e E2E | UI/UX / QA | Épico 3 |
| 15. Operação e suporte | Modelo de suporte, ownership, escalonamento e continuidade | ⚪ Não comprovado | Runbook pós-merge em [`OPERACAO.md`](OPERACAO.md); responsável oficial consta como não designado em [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md) | Não há catálogo de suporte, horários, SLA, on-call, matriz de escalonamento ou continuidade de negócio comprovados. | Incidentes sem dono e expectativa contratual inviável. | Designar owners e aprovar modelo de suporte e continuidade. | Alta | Observabilidade e comercialização | Operação / Produto SaaS | Épico 5 |
| 16. Documentação e governança | Fonte oficial, ADR, DoD e rastreabilidade mantidas | 🟢 Comprovado | Hierarquia e gates em [`GOVERNANCA_DESENVOLVIMENTO.md`](GOVERNANCA_DESENVOLVIMENTO.md); fonte oficial em [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md); ADRs em [`adr/`](adr/) | A classificação comprova a estrutura versionada, não sua adesão histórica ou operacional; revisão periódica ainda deve ser evidenciada. | Governança virar checklist sem execução. | Auditar amostras de PRs e revisar a norma no ciclo definido. | Média | Adoção do processo | Comitê / Documentação | Épico 3 |
| 17. Comercialização, onboarding e licenciamento | Oferta, contratos, provisionamento, billing, onboarding e offboarding definidos | ⚪ Não comprovado | Módulos e bloqueios em [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md); diretório de produto contém apenas [`product/README.md`](product/README.md) | Não foram encontrados planos, licenciamento, billing, termos, SLA, onboarding/offboarding, trial ou operação de provisioning. | Venda não repetível, obrigações indefinidas e alto custo manual. | Desenhar oferta e jornada somente após segurança/isolamento, com critérios verificáveis. | Alta | Épicos 1–4 | Produto SaaS / Comercial | Épico 5 |

## Evidências transversais e limites

- **Autenticação:** access JWT e refresh cookie existem; login humano funcionou após o cutover, sem que isso prove rotação/revogação ou todas as rotas de autorização.
- **RBAC:** middleware 401/403 e várias rotas com `authorize` existem; cobertura negativa completa não
  foi encontrada.
- **Secrets:** `.env.example`, arquivo externo e GitHub Secrets são padrões versionados; configuração
  real e rotação não foram comprovadas.
- **Raw queries e uploads:** há SQL raw em serviços e importação KML com limite no CRUD monolítico;
  não foi encontrada revisão sistemática de segurança/performance desses pontos.
- **Jobs:** schedulers vivem no processo da API; operação, liderança distribuída e recuperação após
  falha não foram comprovadas em produção.
- **Dívida conhecida:** ocorrências TODO/FIXME foram inventariadas, mas texto de interface ou dados
  contendo essas palavras não foi promovido automaticamente a dívida.

## Pontos não comprovados prioritários

1. Convergência pública do SHA `a08a626` via `/health/version` e `build-info.json`, caso as saídas não tenham sido preservadas.
2. Rollback efetivamente executado após o cutover.
3. Restore isolado bem-sucedido, RPO/RTO e estabilidade prolongada.
4. Causa raiz e população real do incidente ERP 5050, apesar da recuperação funcional do 5050.
5. Homologação integral 5050×4484, incluindo 4484 e perfis reconciliados.
6. Capacidade, latência e concorrência sob carga representativa.
7. Isolamento multiempresa, LGPD, SLOs/alertas, acessibilidade e modelo comercial.

## Proposta de sequência de épicos

Sem datas fictícias e condicionada aos gates existentes:

1. **Fechamento dos P0 e incidentes** — corrigir TD-ER-001/TD-ER-002, comprovar restore/rollback e
   preservar evidências dos incidentes sem encerramento antecipado.
2. **Segurança e isolamento** — threat model, sessão/RBAC, LGPD, secrets e fronteiras de dados.
3. **Qualidade e observabilidade** — E2E, testes negativos, performance, SLOs, alertas e resposta.
4. **Multiempresa** — executar os marcos 1.0A–1.0F do assessment: aceitar ADR 003, control plane,
   expand/backfill, data access, jobs/caches/integrações, constraints/RLS, provas A×B e piloto por coorte.
5. **Onboarding e comercialização** — oferta, licenciamento, provisioning, suporte e offboarding.
6. **Evolução funcional** — somente após os gates anteriores, conforme prioridade de produto.

## Atualização controlada — Sprint 0.5

Somente as quatro dimensões operacionais abaixo são atualizadas nesta Sprint. As classificações das
demais dimensões permanecem exatamente como na baseline; a existência de código no Git não comprova
execução em produção.

| Dimensão atualizada | Classificação | Evidência acrescentada | Limite remanescente |
|---|---|---|---|
| Operação | ⚪ Não comprovado | Rotina única, contrato PASS/FAIL e procedimento em [`OPERACAO.md`](OPERACAO.md), com Sprint Brief auditável | Suporte, ownership, SLA, on-call e execução por SHA continuam não comprovados. |
| Observabilidade | 🟡 Parcialmente comprovado | TSVs uniformes de health, runtime, sistema, segurança e ERP; resultado somente após coleta completa | Não há SLO, alerta externo, tracing, retenção central ou game day comprovado. |
| Infraestrutura | 🟡 Parcialmente comprovado | Inspeção read-only de containers, imagens, rede, volume, nginx/TLS, recursos e restart policy | Execução no host, rollback real, hardening e capacidade sob carga continuam pendentes. |
| Continuidade | 🟡 Parcialmente comprovado, condicionado ao check Docker da PR | Verificação não invasiva da configuração de backup/restore e da cadeia de evidência de schema/incidentes | Não executa restore, não consulta o banco e não comprova cópia real, off-site, RPO ou RTO. |

O validador é [`../scripts/production-health-validation.sh`](../scripts/production-health-validation.sh)
e seu smoke estático é
[`../scripts/smoke/production-health-validation-safety.mjs`](../scripts/smoke/production-health-validation-safety.mjs).
Nenhuma classificação de Segurança, Identidade, LGPD, Banco, Qualidade, Performance, Produto,
Arquitetura, Multiempresa, Integrações, UI/UX, Governança ou Comercialização foi alterada.
