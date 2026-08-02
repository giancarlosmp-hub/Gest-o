# Enterprise Readiness — baseline oficial

**Baseline:** Sprint 0.1 — Auditoria Enterprise
**Estado:** 🔵 PR
**Escopo probatório:** repositório no `HEAD e2a41a7` antes desta mudança. Inspeção documental e
estática, sem acesso à VPS, serviços externos ou produção. Esta baseline **não declara o Gest-o
Enterprise-ready**, não fecha incidentes e não transforma código versionado em prova operacional.

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
| 2. Arquitetura | Visão de componentes, limites e decisões duradouras | 🟡 Parcialmente comprovado | [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md#2-arquitetura-ponta-a-ponta); [`adr/README.md`](adr/README.md); [`architecture/README.md`](architecture/README.md) | Topologia de deploy e duas ADRs existem; catálogo de componentes, contratos, ownership e diagramas de domínio ainda não foram documentados. | Acoplamento e mudanças incompatíveis sem análise de impacto. | Publicar arquitetura atual verificável e mapa de dependências. | Alta | Inventário e ADRs vigentes | Arquiteto de Software | Épico 3 |
| 3. Segurança | Hardening web, segredos e superfície de diagnóstico seguros | 🔴 Crítico ou não conforme | `helmet`, CORS allowlist e rate limit em [`apps/api/src/app.ts`](../apps/api/src/app.ts); endpoint público `/debug/admin` retorna prefixo do hash em [`apps/api/src/app.ts`](../apps/api/src/app.ts); investigação de secrets em [`investigations/github-ssh-secrets-check.md`](investigations/github-ssh-secrets-check.md) | O endpoint diagnóstico não exige autenticação; não há threat model, SAST/DAST, gestão de vulnerabilidades ou comprovação do hardening da VPS. | Divulgação de metadados de credencial e ampliação da superfície de ataque. | Remover/restringir diagnóstico por Sprint autorizada e estabelecer baseline de segurança com testes negativos. | Crítica | Gate de segurança; TD-ER-001 | Segurança | Épico 1 |
| 4. Identidade, autenticação e autorização | Sessões revogáveis, RBAC completo e autorização negativa | 🟡 Parcialmente comprovado | JWT e refresh cookie em [`apps/api/src/controllers/authController.ts`](../apps/api/src/controllers/authController.ts); RBAC em [`apps/api/src/middlewares/authorize.ts`](../apps/api/src/middlewares/authorize.ts); rate limit em [`apps/api/src/middlewares/rateLimit.ts`](../apps/api/src/middlewares/rateLimit.ts) | Refresh token não tem rotação/revogação persistida comprovada; logout apenas limpa cookie; não há MFA/SSO nem suíte abrangente de autorização negativa. | Sessão roubada permanece válida e privilégios podem regredir sem detecção. | Definir política de sessão e matriz RBAC; testar negações por rota e objeto. | Alta | Segurança | Segurança / QA | Épico 2 |
| 5. Privacidade e LGPD | Inventário de dados, base legal, direitos, retenção e logs minimizados | 🔴 Crítico ou não conforme | Login registra e-mail e metadados de hash em [`apps/api/src/controllers/authController.ts`](../apps/api/src/controllers/authController.ts); sanitização genérica em [`apps/api/src/utils/logger.ts`](../apps/api/src/utils/logger.ts); retenção de webhook configurável em [`apps/api/src/config/env.ts`](../apps/api/src/config/env.ts) | Não há registro de operações de tratamento, bases legais, DPO, política de retenção global, DSAR ou evidência de expurgo; logging de identidade é excessivo. | Exposição de dados pessoais e incapacidade de atender direitos do titular. | Cessar logging sensível via Sprint própria e aprovar programa LGPD com inventário e testes de retenção. | Crítica | TD-ER-002; gate de segurança | Segurança / Jurídico-Privacidade | Épico 1 |
| 6. Banco de dados | Schema versionado, integridade e migrations reproduzíveis | 🟡 Parcialmente comprovado | Schema, índices e constraints em [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma); ADR de autoridade em [`adr/002-runtime-migration-authority-separation.md`](adr/002-runtime-migration-authority-separation.md); transição em [`investigations/production-schema-transition-july-2026.md`](investigations/production-schema-transition-july-2026.md) | Histórico recuperado não possui ledger confiável e apply/cutover permanecem pendentes; queries raw não têm revisão central comprovada. | Drift, rollback incompatível e integridade divergente entre ambientes. | Baselinear migrations e revisar raw SQL/constraints em base descartável, sem tocar produção nesta entrega. | Crítica | Gate de schema e incidente aberto | DBA PostgreSQL | Épico 1 |
| 7. Backup e restauração | Backup íntegro, protegido e restauração ensaiada | 🔴 Crítico ou não conforme | Criação/validação/rotação em [`ops/backup.md`](ops/backup.md) e [`../backup.sh`](../backup.sh); restauração simples em [`../restore.sh`](../restore.sh); bloqueador registrado em [`STATUS_ATUAL.md`](STATUS_ATUAL.md) | Não há evidência versionada de restore isolado validado, RPO/RTO, criptografia, cópia off-site ou teste periódico; o restore não possui pré/pós-checks robustos. | Perda de dados ou backup inutilizável durante incidente. | Executar e preservar ensaio isolado aprovado; definir RPO/RTO, proteção e runbook de restauração. | Crítica | Gate operacional existente | DBA / DevOps | Épico 1 |
| 8. Deploy e rollback | Publicação identificável, controlada e reversível | 🟡 Parcialmente comprovado | Workflow manual em [`.github/workflows/deploy-production.yml`](../.github/workflows/deploy-production.yml); runbook em [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md); scripts `production-*` | Scripts e gates estão versionados, mas cutover, SHA implantado, rollback ensaiado e última produção continuam não comprovados. | Indisponibilidade ou versão divergente sem recuperação demonstrada. | Executar janela aprovada e registrar todas as identidades e rollback; não inferir deploy do merge. | Crítica | Cutover e incidentes abertos | DevOps | Épico 1 |
| 9. Observabilidade e resposta a incidentes | Métricas, alertas, SLOs, runbooks e resposta auditável | 🟡 Parcialmente comprovado | [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md); logs estruturados em [`apps/api/src/utils/logger.ts`](../apps/api/src/utils/logger.ts); incidentes em [`incidents/`](incidents/) | Painel existe, porém adaptadores de alerta e SLOs são plano; não há traces, on-call, retenção central ou exercício de resposta comprovados. | Falhas podem ser percebidas tarde e sem contexto preservado. | Definir SLIs/SLOs, alertas acionáveis, responsáveis, retenção e game day. | Alta | P0 encerrados | Observabilidade / Operação | Épico 3 |
| 10. Qualidade e testes | Pirâmide automatizada com evidência por revisão e ambiente | 🟡 Parcialmente comprovado | Testes Node em `apps/api/src/**/*.test.ts`; smoke Compose em [`.github/workflows/docker-compose-ci.yml`](../.github/workflows/docker-compose-ci.yml); checklists manuais em [`manual-test-checklist.md`](manual-test-checklist.md) | Não foi encontrada suíte E2E browser, cobertura/threshold, testes de acessibilidade ou evidência desses testes na produção; login no CI usa diagnóstico permissivo durante coleta. | Regressões críticas e de jornada escapam para release. | Formalizar matriz de testes, E2E de fluxos críticos, autorização negativa e evidência por SHA. | Alta | Ambientes representativos | QA | Épico 3 |
| 11. Performance e escalabilidade | Capacidade, limites, concorrência e metas verificadas | ⚪ Não comprovado | Limites/cache descritos em [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md); locks/scheduler em [`apps/api/src/jobs/erpSyncScheduler.ts`](../apps/api/src/jobs/erpSyncScheduler.ts) | Não foram encontrados SLO de latência/capacidade, testes de carga, sizing ou resultados de concorrência. | Saturação e custo imprevisíveis com crescimento. | Definir workload, metas e teste reprodutível antes de alegar escala. | Alta | Observabilidade e arquitetura | Plataforma / Performance | Épico 3 |
| 12. Multiempresa e isolamento | Isolamento integral de dados, jobs, cache e integrações por empresa | 🔴 Crítico ou não conforme | `tenantId` aparece somente no domínio Communications em [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma); bloqueio explícito em [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md) e [`GOVERNANCA_DESENVOLVIMENTO.md`](GOVERNANCA_DESENVOLVIMENTO.md) | Modelos centrais e identidade não possuem boundary multiempresa comprovada; nenhuma prova negativa cross-tenant. | Vazamento entre empresas se a plataforma for comercializada como multiempresa. | Manter alegação bloqueada; decidir tenancy por ADR e provar isolamento ponta a ponta. | Crítica | Arquitetura, identidade e segurança | Arquitetura / Segurança | Épico 4 |
| 13. Integrações e API | Contratos, autenticação, idempotência, versionamento e quotas | 🟡 Parcialmente comprovado | UltraFV3 documentado em [`erp-ultrafv3-integration-technical.md`](erp-ultrafv3-integration-technical.md); Communications em [`communications/secure-omnichannel-foundation.md`](communications/secure-omnichannel-foundation.md); IA em [`investigations/ollama-ai-integration-diagnosis.md`](investigations/ollama-ai-integration-diagnosis.md) | Não há catálogo/OpenAPI, política de versão/depreciação, SLA de providers ou prova operacional completa de UltraFV3, WhatsApp e IA. | Quebra de consumidores, duplicidade e dependência externa não controlada. | Inventariar contratos, owners, idempotência, quotas e testes de falha por integração. | Alta | Incidentes UltraFV3; segurança | Arquiteto de Integrações | Épico 2 |
| 14. UI/UX e acessibilidade | Jornadas responsivas e conformidade de acessibilidade testada | 🟡 Parcialmente comprovado | Breakpoints e atributos ARIA em `apps/web/src`; descrição responsiva em [`dashboard-saude-plataforma.md`](dashboard-saude-plataforma.md) | Não há auditoria WCAG, testes automatizados, matriz de dispositivos, navegação por teclado ou pesquisa de usabilidade comprovadas. | Exclusão de usuários, barreira comercial e regressões móveis. | Definir nível WCAG alvo e executar auditoria/testes de jornadas críticas. | Alta | Design system e E2E | UI/UX / QA | Épico 3 |
| 15. Operação e suporte | Modelo de suporte, ownership, escalonamento e continuidade | ⚪ Não comprovado | Runbook pós-merge em [`OPERACAO.md`](OPERACAO.md); responsável oficial consta como não designado em [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md) | Não há catálogo de suporte, horários, SLA, on-call, matriz de escalonamento ou continuidade de negócio comprovados. | Incidentes sem dono e expectativa contratual inviável. | Designar owners e aprovar modelo de suporte e continuidade. | Alta | Observabilidade e comercialização | Operação / Produto SaaS | Épico 5 |
| 16. Documentação e governança | Fonte oficial, ADR, DoD e rastreabilidade mantidas | 🟢 Comprovado | Hierarquia e gates em [`GOVERNANCA_DESENVOLVIMENTO.md`](GOVERNANCA_DESENVOLVIMENTO.md); fonte oficial em [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md); ADRs em [`adr/`](adr/) | A classificação comprova a estrutura versionada, não sua adesão histórica ou operacional; revisão periódica ainda deve ser evidenciada. | Governança virar checklist sem execução. | Auditar amostras de PRs e revisar a norma no ciclo definido. | Média | Adoção do processo | Comitê / Documentação | Épico 3 |
| 17. Comercialização, onboarding e licenciamento | Oferta, contratos, provisionamento, billing, onboarding e offboarding definidos | ⚪ Não comprovado | Módulos e bloqueios em [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md); diretório de produto contém apenas [`product/README.md`](product/README.md) | Não foram encontrados planos, licenciamento, billing, termos, SLA, onboarding/offboarding, trial ou operação de provisioning. | Venda não repetível, obrigações indefinidas e alto custo manual. | Desenhar oferta e jornada somente após segurança/isolamento, com critérios verificáveis. | Alta | Épicos 1–4 | Produto SaaS / Comercial | Épico 5 |

## Evidências transversais e limites

- **Autenticação:** access JWT e refresh cookie existem; sua execução em produção não foi observada.
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

1. SHA, imagem, stack e data da revisão realmente implantada.
2. Restore isolado bem-sucedido e objetivos de recuperação aprovados.
3. Causa raiz e população real do incidente ERP 5050.
4. Homologação integral 5050×4484 com perfis reconciliados.
5. Capacidade, latência e concorrência sob carga representativa.
6. Isolamento multiempresa fora de Communications.
7. SLOs, alertas externos, on-call e exercício de incidente.
8. Conformidade LGPD, acessibilidade e modelo comercial/contratual.

## Proposta de sequência de épicos

Sem datas fictícias e condicionada aos gates existentes:

1. **Fechamento dos P0 e incidentes** — remover exposições por Sprint própria, comprovar restore,
   concluir gates de schema/cutover e preservar evidências dos incidentes sem encerramento antecipado.
2. **Segurança e isolamento** — threat model, sessão/RBAC, LGPD, secrets e fronteiras de dados.
3. **Qualidade e observabilidade** — E2E, testes negativos, performance, SLOs, alertas e resposta.
4. **Multiempresa** — ADR, modelo de tenancy e provas de isolamento em todos os componentes.
5. **Onboarding e comercialização** — oferta, licenciamento, provisioning, suporte e offboarding.
6. **Evolução funcional** — somente após os gates anteriores, conforme prioridade de produto.
