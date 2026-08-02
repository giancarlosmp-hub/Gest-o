# Dívida técnica — achados da Sprint 0.1

Este backlog contém somente achados desta auditoria. Ele não implementa correções, não duplica
incidentes e não altera seu estado. `INC-5050-4484`, `INC-ERP-5050` e `INC-PROD-2026-07`
continuam nas fontes oficiais; são dependências referenciadas, não novos itens. Schema e cutover
local foram comprovados posteriormente, sem comprovar restore ou encerramento dos incidentes.

## P0 — risco imediato a dados, segurança ou produção

### TD-ER-001 — Endpoint diagnóstico público expõe metadado de credencial

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
| TD-ER-003 | Restauração e objetivos de recuperação não comprovados | [`ops/backup.md`](ops/backup.md), [`../restore.sh`](../restore.sh), [`STATUS_ATUAL.md`](STATUS_ATUAL.md) | Crítica | Perda de dados/continuidade não demonstrada | Gate operacional e ambiente isolado | Restore integral ensaiado com checksum, pré/pós-condições, RPO/RTO e evidência aprovada | Épico 1 |
| TD-ER-004 | Tenancy incompleta nos domínios centrais | [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma), [`GOVERNANCA_DESENVOLVIMENTO.md`](GOVERNANCA_DESENVOLVIMENTO.md) | Crítica | Risco de acesso cruzado e alegação comercial indevida | ADR, identidade e autorização | ADR aceita e testes negativos provam isolamento de banco, cache, jobs, uploads e integrações | Épico 4 |
| TD-ER-005 | Gestão de sessão sem rotação/revogação comprovada | [`apps/api/src/controllers/authController.ts`](../apps/api/src/controllers/authController.ts), [`apps/api/src/utils/jwt.ts`](../apps/api/src/utils/jwt.ts) | Alta | Refresh token roubado segue válido até expirar | Política de identidade | Política aprovada; rotação, revogação e testes de replay/logout comprovados | Épico 2 |
| TD-ER-006 | Programa LGPD não documentado | [`ENTERPRISE_READINESS.md`](ENTERPRISE_READINESS.md#matriz-por-dimensão) | Crítica | Direitos, retenção e base legal não demonstráveis | Inventário de dados e jurídico | ROPA, bases legais, retenção, DSAR, responsáveis e evidências de execução aprovados | Épico 2 |
| TD-ER-007 | Oferta, onboarding, licenciamento e suporte ausentes da documentação | [`product/README.md`](product/README.md), [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md) | Alta | Comercialização e operação não repetíveis | Segurança, isolamento e owners | Oferta, limites, termos, provisioning, onboarding/offboarding e suporte aprovados/testados | Épico 5 |

## P2 — importante para escala ou qualidade

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
