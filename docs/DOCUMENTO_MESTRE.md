# ADENDO HISTÓRICO — segurança de deploy pós-recuperação

> 🔵 Entrega em PR (31/07/2026), sem VPS ou produção. A topologia isolada API/WEB exige identidade do banco recuperado, separa build/preflight do cutover humano, permite rollback dos containers históricos e prova o SHA. O banco recuperado segue vigente até migração formal e o incidente continua aberto. Consulte `DEPLOY_GUIDE.md`.

> Este adendo preserva o estado intermediário de 31/07. O estado vigente após o cutover de 01/08
> está no painel [Estado Atual da Produção](#estado-atual-da-produção).

> O preflight de PostgreSQL deve resolver o hostname interno por um container efêmero na rede `gest-o_default`, nunca pelo DNS do host ou por IP fixo. A imagem `postgres:16` precisa existir localmente e não pode ser baixada automaticamente durante a janela.

---

# Gest-o — Documento Mestre

> **Fonte única de verdade do projeto.** Comece por este documento. Investigações, ADRs e runbooks
> guardam detalhe e evidência, mas o estado oficial, a prioridade e os gates são os registrados aqui.
> Em caso de divergência, corrija este documento na mesma PR da mudança.

## Índice oficial

- [Estado atual](STATUS_ATUAL.md)
- [Operação pós-merge](OPERACAO.md)
- [Guia de deploy](DEPLOY_GUIDE.md)
- [Governança de desenvolvimento](GOVERNANCA_DESENVOLVIMENTO.md)
- [Enterprise Readiness — baseline oficial](ENTERPRISE_READINESS.md)
- [Sprint 0.1 — Auditoria Enterprise](sprints/SPRINT_0_1_ENTERPRISE_READINESS.md)
- [Sprint 0.5 — Validação operacional Enterprise](sprints/SPRINT_0_5_ENTERPRISE_OPERATIONAL_VALIDATION.md)
- [Dívida técnica auditada](TECH_DEBT.md)
- [ADRs](adr/README.md)
- [Sprint 1.0A — Multi-Tenancy Foundation](sprints/SPRINT_1_0A_MULTI_TENANCY_FOUNDATION.md)
- [Threat Model Multi-Tenancy](security/MULTI_TENANCY_THREAT_MODEL.md)
- [Plano da migration expand](tenancy/MIGRATION_EXPAND_PLAN.md)
- [Sprint 1.0B.1 — persistência do control plane](sprints/SPRINT_1_0B_1_CONTROL_PLANE_PERSISTENCE.md)
- [Preparação do control plane](tenancy/CONTROL_PLANE_PREPARATION.md)

## ADENDO DA SPRINT 0.5 — CERTIFICAÇÃO OPERACIONAL

A rotina oficial de certificação de uma instalação é `scripts/production-health-validation.sh`,
descrita em [`OPERACAO.md`](OPERACAO.md). Ela coleta evidência por SHA sem consultar ou alterar o
banco e sem executar publicação ou recuperação. A existência do validador no Git não comprova sua
execução nem muda o estado conhecido da produção; promoção depende de `result.tsv` PASS revisado
no host autorizado. O estágio desta entrega permanece 🔵 PR.

## ADENDO DA SPRINT 1.0A — DECISÃO E CONTROL PLANE

A [ADR 003](adr/003-shared-schema-tenant-boundary.md) foi aceita em 02/08/2026 pelo Comitê
registrado por papéis, condicionada a contexto fail-closed, data access tenant-required, expansão
progressiva, constraints compostas, RLS defensiva e provas A×B. A entrega adiciona somente contratos
e testes default-only; não altera schema, banco, deploy ou produção e não habilita outra empresa.
Multiempresa continua 🔴 até o roadmap 1.0B–1.0F e a evidência operacional. O threat model, RACI e
gates estão no [Brief 1.0A](sprints/SPRINT_1_0A_MULTI_TENANCY_FOUNDATION.md).

## ADENDO DA SPRINT 1.0B.1 — PERSISTÊNCIA DEFAULT-ONLY

Esta entrega em 🔵 PR persiste o control plane e prepara um único tenant default por runner
explícito, transacional e reconciliável. Não aplicou migration em produção, não executou deploy e
não altera models empresariais, autenticação ou handlers. O runtime legado continua single-tenant e
Multiempresa permanece 🔴 até os gates das etapas seguintes.

## 1. RESUMO EXECUTIVO

| Campo | Estado oficial em 02/08/2026 |
|---|---|
| **Versão atual** | Documento Mestre **4.0**; última revisão operacional conhecida `a08a62670c4940322ce037d0c86c54959db32f71` |
| **Último commit em produção** | Cutover local comprovado para `a08a62670c4940322ce037d0c86c54959db32f71`; confirmação pública por `/health/version` e `build-info.json` permanece não comprovada caso as saídas não tenham sido preservadas. |
| **Última PR mesclada** | **#763**, merge `a08a626` em 01/08/2026, como revisão operacional do cutover; a baseline documental está na PR #765. |
| **Sprint atual** | **Estabilização, identidade UltraFV3 e verificabilidade de produção** |
| **Status do sistema** | Produção funcionalmente validada após cutover; **🟡 Atenção** permanece para estabilidade prolongada, restore, P0 de segurança e incidentes ainda não encerrados. |
| **Última atualização** | 02/08/2026 |
| **Responsável** | **Não designado no repositório**; até designação formal, o responsável por cada deploy/PR deve atualizar este documento. |

**Leitura em cinco minutos:** schema e cutover local foram concluídos para `a08a626`; novos
containers iniciaram e o usuário validou login, navegação, sincronização, presença do 5050 e Saúde da
Plataforma. Isso comprova recuperação funcional, não certificação Enterprise nem encerramento dos
incidentes. Persistem confirmação pública por SHA, estabilidade prolongada, restore e P0 de segurança.

## ESTADO ATUAL DA PRODUÇÃO

> **Painel fixo de rastreabilidade.** Atualizar após toda publicação ou tentativa de publicação.
> Nenhum valor pode ser inferido do Git local: preencher somente com evidência obtida pelo
> [`OPERACAO.md`](OPERACAO.md). Enquanto não houver evidência, manter “Não comprovado”.

| Campo | Estado comprovado |
|---|---|
| **Versão implantada** | **Não comprovada.** A versão declarada no repositório é `1.0.0`, mas ainda precisa ser conferida no runtime. |
| **Commit implantado** | Cutover local associado a `a08a62670c4940322ce037d0c86c54959db32f71`; falta consolidar prova pública por `/health/version` e `build-info.json`, caso não preservada. |
| **Último deploy** | 01/08/2026: schema aplicado, cutover local concluído e containers API/WEB iniciados. Horário UTC e operador não constam desta reconciliação. |
| **Última PR publicada** | Revisão operacional conhecida da PR #763 (`a08a626`); publicação pública por SHA ainda requer evidência técnica preservada. |
| **Última PR apenas mesclada** | PR #764 (`e2a41a7`) no histórico local; publicação não inferida. PR #765 segue em 🔵 PR. |
| **Última PR aguardando deploy** | PR #765, exclusivamente documental; seu merge/deploy não é inferido. |
| **Última validação operacional** | Usuário confirmou CRM, login, navegação, sync de clientes, ERP 5050 e Saúde da Plataforma; estabilidade prolongada, restore e prova pública completa por SHA permanecem pendentes. |

Uma mesma PR pode aparecer como “apenas mesclada” e “aguardando deploy”: ela só sai desses campos
quando a publicação for comprovada. Depois do deploy, mas antes dos testes, seu estágio é
**🟠 Deploy**; somente após toda a REGRA 001 ela pode constar como **🟢 Produção**.

## 2. ONDE PARAMOS

| Pergunta | Resposta oficial |
|---|---|
| **Última funcionalidade concluída** | Dashboard Saúde da Plataforma, mesclado na PR **#749** (`2f9cfd2`), com visão operacional de saúde e auditoria. |
| **Última funcionalidade parcialmente concluída** | Correção do matching de identidade UltraFV3 para filiais 5050×4484: regra, regressões A–H, auditoria de escritores e monitoramento foram implementados; a validação com filiais independentes ainda não terminou. |
| **Próxima funcionalidade** | Convergência **Activity First**, inicialmente apenas inventário dos contratos legados, plano de migração e testes de não regressão. Implementação só começa depois dos gates abaixo. |
| **Bloqueadores** | (1) preservar confirmação pública de SHA de API/WEB; (2) homologar 5050×4484 incluindo 4484 e perfis; (3) produzir veredito do ERP 5050; (4) provar restore e revisar hardening; (5) corrigir TD-ER-001 e TD-ER-002. |
| **Decisões tomadas** | Documento completo e código exato são identidades fortes; nome+cidade+UF só é fallback sem documento e sem código conflitante; documentos completos distintos nunca são mesclados; integrações passam pelo backend; atividades são a direção da agenda; deploy nunca reseta dados; evidências precedem saneamento. |

### Não iniciar antes de concluir os bloqueadores

- outbound ou automações de WhatsApp, Facebook ou Instagram;
- novo chat/RAG, expansão da IA Comercial ou automação baseada em IA;
- novos domínios de Financeiro, Fretes ou ERP futuro;
- aplicativo, tenancy, marketplace ou plataforma multiempresa;
- saneamento destrutivo dos clientes 5050/4484 ou merges em massa;
- implementação Activity First além do planejamento e dos testes de compatibilidade.

## 3. FUNCIONALIDADES

### Estágios oficiais de entrega

Esta classificação registra **até onde uma entrega comprovadamente avançou**. Ela não substitui o
status funcional da tabela abaixo: um módulo pode estar operacional enquanto uma nova alteração
desse módulo ainda está em Codex, PR, Merge ou Deploy.

| Status | Significado |
|---|---|
| 🟣 **Codex** | Apenas desenvolvido; ainda não há Pull Request criada. |
| 🔵 **PR** | Pull Request criada, em revisão ou aguardando merge. |
| 🟡 **Merge** | Mesclado no GitHub, ainda sem publicação comprovada na VPS. |
| 🟠 **Deploy** | Publicado na VPS, ainda sem validação completa em produção. |
| 🟢 **Produção** | Deploy, operação, health checks e smoke tests validados em produção. |

Os estágios são progressivos e baseados em evidência. **“Pronto” sem deploy e validação nunca
significa Produção.** Por exemplo, uma entrega mesclada, mas ainda não validada na VPS, permanece
em **🟡 Merge**, e não em **🟢 Produção**. A promoção para Produção obedece obrigatoriamente à
[REGRA 001](#regra-001--encerramento-obrigatório-do-ciclo-da-pull-request).

Os únicos status válidos nesta tabela são **Não iniciado**, **Em desenvolvimento**, **Em
homologação**, **Em produção** e **Pausado**. “Em produção” descreve disponibilidade conhecida, não
elimina dívida ou próximos passos. `—` significa que não há commit/PR específico comprovado no
registro atual; nunca preencher por suposição.

| Módulo | Status | Dependências | Último commit | Última PR | Próximo passo |
|---|---|---|---|---|---|
| CRM | Em produção | PostgreSQL, API, autenticação, UltraFV3 | `fdfce21` (referência do repo; revisão de produção a confirmar) | #750 | Fechar incidentes e regressões antes de ampliar o núcleo. |
| UltraFV3 | Em homologação | Credenciais ERP, identidade, auditoria, banco e scheduler | `03cba5e` | #748 | Executar A–H, confirmar 5050 e 4484 independentes e reconciliar perfis. |
| Dashboard Comercial | Em produção | CRM, oportunidades, metas e vendas | Não catalogado | Não catalogada | Registrar revisão implantada e executar smoke do fluxo comercial. |
| Dashboard Saúde | Em produção | API de saúde, métricas, auditoria e permissões | `2f9cfd2` | #749 | Validar dados reais e definir SLOs sem expandir escopo. |
| IA Comercial | Em desenvolvimento | Provider/Ollama, permissões, capacidade e governança | Não catalogado | Não catalogada | Manter pausada a expansão até aprovar provider, limites e segurança. |
| Base Conhecimento IA | Em desenvolvimento | IA Comercial, documentos, curadoria e autorização | `fdfce21` (estado documental) | #750 | Definir curadoria, acesso e qualidade antes de RAG novo. |
| Categorias IA | Não iniciado | Base de Conhecimento IA e modelo de governança | — | — | Especificar somente após concluir os gates da IA. |
| WhatsApp | Em desenvolvimento | Fundação omnichannel, Meta, tenancy, retenção e observabilidade | Não catalogado | Não catalogada | Homologar inbound; não iniciar outbound. |
| Meta WhatsApp | Em homologação | App Meta, webhook, segredos e checklist de go-live | Não catalogado | Não catalogada | Concluir gate de produção e validação operacional inbound. |
| Facebook | Não iniciado | Fundação omnichannel e aprovação de canal | — | — | Não iniciar antes dos bloqueadores e gates de segurança. |
| Instagram | Não iniciado | Fundação omnichannel e aprovação de canal | — | — | Não iniciar antes dos bloqueadores e gates de segurança. |
| Activity First | Pausado | Inventário legado, migração compatível e testes | Não catalogado | Não catalogada | Preparar inventário/plano; aguardar gates para implementar. |
| Financeiro | Em desenvolvimento | UltraFV3, identidade confiável e reconciliação | Não catalogado | Não catalogada | Estabilizar perfis/títulos atuais; não ampliar domínio. |
| Fretes | Não iniciado | Contrato de domínio e fonte de verdade ERP | — | — | Manter no backlog até estabilização do ciclo ERP. |
| Aplicativo | Não iniciado | APIs estáveis, autenticação e prioridades móveis | — | — | Validar caso de negócio após a fundação atual. |
| ERP futuro | Não iniciado | Ciclo UltraFV3 estável, contratos, idempotência e auditoria | — | — | Definir fonte de verdade por domínio, sem implementação agora. |

## 4. INCIDENTES

**Regra:** o incidente **5050×4484 permanece EM HOMOLOGAÇÃO enquanto qualquer filial esperada
continuar ausente**, ainda que os testes de código estejam verdes.

| ID | Título | Status | Critérios para encerramento | Evidências | Último teste |
|---|---|---|---|---|---|
| INC-5050-4484 | Merge indevido de filiais UltraFV3 5050 e 4484 | **EM HOMOLOGAÇÃO** | Revisão implantada confirmada; casos A–H aprovados; 5050 e 4484 presentes com IDs, códigos e documentos próprios; perfis financeiros reconciliados; nenhuma filial ausente; métricas/logs preservados sem PII. | [Investigação 5050×4484](investigations/ultrafv3-partner-identity-5050-4484.md), ADR 001 e auditoria `Client.code` | Sincronização aprovada e 5050 presente; ainda faltam comprovação de 4484, perfis, A–H completos e demais evidências formais. |
| INC-ERP-5050 | Arquivamento/ausência de clientes associado ao ERP 5050 | **INVESTIGANDO** | Evidência read-only correlacionada com revisão, runtime e `ErpSyncRun`; causa/veredito revisável; correção validada; documentação e monitoramento atualizados. | [Análise forense](investigations/erp-5050-forensic-analysis.md) e [runbook](runbooks/erp-5050-forensic.md) | Recuperação funcional comprovada: sync aprovado e 5050 presente; causa raiz/veredito formal continuam pendentes. |
| INC-PROD-2026-07 | Comprometimento e recuperação do PostgreSQL de produção | **CORRIGIDO — AGUARDANDO ENCERRAMENTO** | Backup restaurável exercitado, hardening revisado, revisão implantada registrada e monitoramento sem recorrência; então mover para Encerrado. | [Recuperação](incidents/2026-07-19-final-recovery-runbook.md) e [reconciliação](incidents/2026-07-17-prod-recovery-reconciliation.md) | Schema/cutover e validação funcional concluídos sem relato de perda; estabilidade prolongada e restore isolado pendentes. |

Fluxo permitido: **ABERTO → INVESTIGANDO → CORRIGIDO → HOMOLOGANDO → ENCERRADO**. Um incidente só é
encerrado com critérios satisfeitos, evidências ligadas, data/resultado do último teste registrados
e cumprimento da [REGRA 002](#regra-002--encerramento-de-incidentes).

## 5. PRÓXIMA SPRINT

1. Corrigir TD-ER-001 e TD-ER-002 na primeira Sprint de implementação após esta baseline.
2. Homologar a identidade UltraFV3 com os casos A–H e uma sincronização controlada, sem saneamento destrutivo.
3. Confirmar que 5050 e 4484 existem como filiais independentes e reconciliar seus perfis financeiros.
4. Correlacionar a coleta forense com `ErpSyncRun` e publicar o veredito do incidente ERP 5050.
5. Restaurar um dump validado por SHA256 em ambiente isolado e registrar o resultado.
6. Revisar hardening e acessos mínimos da VPS/PostgreSQL.
7. Inventariar contratos legados de agenda/atividade e aprovar o plano Activity First com testes de não regressão.

## 6. BACKLOG

### P0 — impede avanço seguro
- Corrigir TD-ER-001 (`/debug/admin`) e TD-ER-002 (logs sensíveis de login).
- Homologar e encerrar 5050×4484 sem filiais ausentes.
- Confirmar revisão/topologia de produção e concluir o veredito ERP 5050.
- Exercitar restauração de backup e revisar hardening do VPS.

### P1 — próximo após P0
- Planejar e executar a convergência Activity First com compatibilidade.
- Completar ciclo comercial UltraFV3 com idempotência, auditoria e reconciliação.
- Governar IA Comercial/Base de Conhecimento antes de novo RAG.
- Levar Meta WhatsApp inbound pelo gate de produção.

### P2 — expansão condicionada
- Categorias IA; Inbox e outbound WhatsApp governados.
- Financeiro completo e Fretes, após contrato/fonte de verdade aprovados.
- Facebook e Instagram após maturidade omnichannel.

### P3 — estratégico
- Aplicativo, ERP futuro ampliado, tenancy/multiempresa, marketplace e ecossistema.

## 7. PROCEDIMENTOS VPS

> Execute os comandos exatos dos runbooks ligados; este checklist é o gate oficial. Nunca exiba
> segredos, nunca use reset destrutivo e nunca trate nome de container como prova de destino.

### Checklist oficial de deploy
- [ ] Identificar responsável, janela, PR/commit candidato e plano de rollback.
- [ ] Confirmar acesso, espaço em disco, saúde atual, containers, rede, volumes e database destino.
- [ ] Criar backup lógico pelo usuário local `postgres`, validar o dump e registrar SHA256 fora do volume alterado.
- [ ] Confirmar que segredos estão somente no ambiente e preservar o volume PostgreSQL oficial.
- [ ] Revisar migrations; aplicar apenas o fluxo versionado e não destrutivo.
- [ ] Publicar a imagem/commit aprovado conforme [deploy de produção](deploy-production.md).
- [ ] Registrar horário, operador, commit, imagem, containers e resultado no registro operacional/PR.

### Checklist oficial pós-deploy
- [ ] Verificar endpoint de saúde, frontend, login e logs sem erro crítico.
- [ ] Confirmar commit/build efetivo, conexão sanitizada, database, rede, volume e migrations aplicadas.
- [ ] Executar smokes de API e fluxos críticos (CRM, oportunidade e integração afetada).
- [ ] Quando UltraFV3 for afetado, validar A–H e métricas antes de sincronização ampla.
- [ ] Confirmar integridade/contagens, ausência de escrita destrutiva e preservação de filiais.
- [ ] Atualizar este documento, `STATUS_ATUAL.md`, incidente e evidências com resultado e horário.
- [ ] Monitorar durante a janela acordada; só então declarar deploy concluído.

### Checklist oficial de rollback
- [ ] Interromper novas escritas/schedulers afetados e registrar motivo/horário.
- [ ] Preservar logs, manifestos, hashes e estado atual antes de qualquer reversão.
- [ ] Reimplantar a última imagem **comprovadamente saudável**; não usar apenas “a anterior” por nome.
- [ ] Não reverter migration destrutivamente; restaurar banco somente por decisão explícita e ensaio isolado.
- [ ] Se restauração for necessária, validar dump/SHA256, restaurar primeiro isoladamente e conferir integridade.
- [ ] Reexecutar todo o checklist pós-deploy e registrar o resultado do rollback.
- [ ] Abrir/atualizar incidente e manter o sistema em atenção até cumprir critérios de encerramento.

## 8. COMO CONTINUAR O PROJETO

1. Leia as seções 1–6 e não comece item marcado como bloqueado.
2. Confirme `git status`, branch e `git log`; nunca confunda o `HEAD` local com produção.
3. Leia o [README](../README.md), a [arquitetura](architecture/README.md), o ADR aplicável e o runbook da operação.
4. Escolha o primeiro P0 sem responsável; registre escopo, aceite, risco, dependências e evidências esperadas.
5. Para produção, descubra a topologia real antes de agir. A referência conhecida é API
   `gest-o-api-recovery-20260718` → rede `gest-o_default` → PostgreSQL
   `gest-o-db-clean-v2-20260717` → database `salesforce_pro`.
6. Faça mudanças mínimas e compatíveis. Integrações externas ficam no backend; segredos não entram
   no Git; dados/documentos completos não entram em logs.
7. Rode testes do módulo e smokes críticos. Alterações de identidade UltraFV3 exigem os casos A–H;
   alterações de deploy exigem backup e rollback ensaiáveis.
8. Atualize, na mesma PR, a linha do módulo, incidentes, próxima sprint, changelog (se grande entrega),
   `STATUS_ATUAL.md` e documentos especializados. Documentação faz parte da Definition of Done.
9. Na entrega, informe commit/PR, evidências, limitações e próximo passo. Não marque concluído sem
   aceite objetivo; hipótese não vira fato.

### Regras permanentes
- O Documento Mestre governa estado e prioridade; ADR governa o porquê; runbook governa execução;
  investigação guarda hipótese/evidência; arquitetura governa limites técnicos.
- Backups administrativos usam `docker exec -u postgres`, `psql -U postgres` e `pg_dump -U postgres`
  com autenticação peer; não dependem de `POSTGRES_USER`, `POSTGRES_PASSWORD` ou `DATABASE_URL`.
- Dados reais, código do repositório e revisão implantada são fontes distintas e devem ser correlacionadas.

### REGRA 001 — encerramento obrigatório do ciclo da Pull Request

Nenhuma Pull Request poderá ser considerada concluída até que **todas** as etapas abaixo estejam
concluídas:

- [ ] Merge realizado.
- [ ] Deploy realizado.
- [ ] [`OPERACAO.md`](OPERACAO.md) executado.
- [ ] Health check aprovado.
- [ ] Smoke tests aprovados.
- [ ] Produção validada.
- [ ] `STATUS_ATUAL.md` atualizado.
- [ ] Documento Mestre atualizado.
- [ ] Incidente atualizado, quando aplicável.

Somente após todos esses itens a funcionalidade poderá receber o estágio **🟢 Produção**. Até lá,
deve permanecer no último estágio objetivamente comprovado da tabela de estágios oficiais de
entrega, mesmo que o desenvolvimento e o merge já tenham terminado.

A descrição da PR ou o registro operacional deve declarar explicitamente a evidência de cada item.
“Não aplicável” é aceito somente para incidente, com justificativa. A revisão do `STATUS_ATUAL.md`,
do Documento Mestre, da seção **NEXT_SPRINT** e do **CHANGELOG Executivo** nunca pode ser omitida;
quando não houver mudança, registrar expressamente “revisado, sem alteração necessária”.

### REGRA 002 — encerramento de incidentes

Nenhum incidente poderá ser encerrado enquanto existir qualquer teste funcional pendente em
produção.

A existência de código corrigido, teste local aprovado, Pull Request criada ou PR mesclada não é
evidência suficiente. O encerramento depende de validação operacional no ambiente de produção, com
resultado, data e evidências registrados no incidente.

Se a correção estiver mesclada ou implantada, mas o teste funcional em produção ainda estiver
pendente, o incidente deve permanecer em **CORRIGIDO** ou **HOMOLOGANDO**, conforme o estágio
comprovado. Somente a validação completa permite **ENCERRADO**.

### REGRA 003 — início obrigatório de Sprint

Toda Sprint começa obrigatoriamente lendo, nesta ordem:

1. [`STATUS_ATUAL.md`](STATUS_ATUAL.md) — retomada operacional e alertas imediatos;
2. **Documento Mestre** — estado oficial, decisões, prioridades e gates;
3. **Incidentes abertos** — seção [Incidentes](#4-incidentes) e respectivas evidências;
4. **Última PR publicada** — identificada no painel [Estado Atual da Produção](#estado-atual-da-produção), com evidência operacional;
5. **Backlog P0** — seção [Backlog](#6-backlog), antes de escolher qualquer novo desenvolvimento.

Somente depois dessa leitura e da confirmação de que as informações continuam válidas pode começar
novo desenvolvimento. Itens incompletos devem ser encerrados ou transportados explicitamente, e a
seção Próxima Sprint deve registrar objetivo, ordem e critérios verificáveis. Conversas antigas não
substituem essa sequência.

## 9. CHANGELOG EXECUTIVO

- **02/08/2026 — Sprint 0.4 em 🔵 PR:** preparação read-only separa explicitamente merge, deploy
  oficial, validação de TD-ER-001/002 por SHA, estabilidade e restore autorizado descartável. Os
  merges #766/#767 não comprovam publicação; nenhum restore, débito ou incidente foi encerrado.

- **02/08/2026 — Sprint 0.3 em 🔵 PR:** ensaio sintético e isolado de restore em PostgreSQL 16,
  checksum, catálogo, pós-condições e evidência metadatal, com RPO/RTO apenas propostos. Não houve
  restore real; `INC-PROD-2026-07` e `TD-ER-003` permanecem abertos até validação operacional.

- **02/08/2026 — Sprint 0.2 em 🔵 PR:** remove `/debug/admin` e minimiza logs de autenticação.
  TD-ER-001/002 seguem abertos até merge, deploy e validação por SHA; não há inferência de produção
  nem declaração de Segurança/LGPD resolvidas.

| Data | Grande entrega |
|---|---|
| 02/08/2026 | Sprint 0.4 prepara evidência sanitizada pós-deploy e comando de restore autorizado separado, sem VPS, deploy, restore real ou mudança de classificação. |
| 02/08/2026 | Sprint 0.3 cria ensaio descartável de recuperação e CI sintético, sem VPS ou produção; continuidade, restore real e RPO/RTO aprovados continuam não comprovados. |
| 02/08/2026 | Baseline reconciliada com a operação de 01/08: schema aplicado, pós-diff gerenciado vazio, oito `incident_*` preservadas, cutover local em `a08a626` e validação funcional de login, sync, 5050 e Saúde; prova pública completa por SHA, estabilidade, restore, P0 e encerramento de incidentes permanecem pendentes. |
| 02/08/2026 | Baseline oficial de Enterprise Readiness e Sprint 0.1 criadas em 🔵 PR, com 17 dimensões e backlog baseado em evidências; auditoria exclusivamente documental/read-only, sem alteração ou declaração sobre produção e sem encerramento de incidentes. |
| 01/08/2026 | Governança de desenvolvimento institucionalizada: Comitê de Arquitetura, Sprint Brief, ciclo de ADR, Enterprise Readiness, revisão, testes, rollback e Definition of Done consolidados em norma permanente, sem alteração de runtime ou produção. |
| 01/08/2026 | Diagnóstico confirmou evidência de schema íntegra e Prisma equivalente; allowlist operacional incompleta foi o único bloqueio. Produção e containers antigos preservados, sem deploy ou cutover; correção em 🔵 PR e cutover pendente. |
| 01/08/2026 | Schema aplicado/validado e evidência revalidada para `c178a69e`; segundo ensaio parou antes de containers por ausência da imagem histórica da API. Produção antiga preservada, cutover pendente e rollback híbrido em 🔵 PR; incidente aberto. |
| 01/08/2026 | Schema apply permanece pendente: a tentativa controlada foi bloqueada com segurança, antes de qualquer SQL, pela incompatibilidade da URI Prisma com `psql`; correção operacional em PR, produção e tabelas `incident_*` preservadas e cutover ainda bloqueado. |
| 31/07/2026 | Criado o painel fixo Estado Atual da Produção e instituídas as REGRA 002 (incidentes) e REGRA 003 (início de Sprint). |
| 31/07/2026 | Instituída a REGRA 001 para fechamento obrigatório do ciclo pós-merge e a escala Codex → PR → Merge → Deploy → Produção. |
| 31/07/2026 | Documento Mestre 4.0 convertido em fonte única operacional, com estado, gates, backlog e procedimentos VPS; criado resumo `STATUS_ATUAL.md`. |
| 30/07/2026 | Dashboard Saúde da Plataforma entregue (PR #749). |
| 30/07/2026 | Observabilidade/auditoria da identidade UltraFV3 e trilha de `Client.code` entregues (PR #748). |
| 30/07/2026 | Regra segura de identidade 5050×4484 consolidada, com regressões A–H e ADR. |
| 17–19/07/2026 | Produção recuperada em PostgreSQL limpo, órfãos reconciliados e FKs restauradas. |
| 21/07/2026 | Fundação omnichannel segura congelada com gates explícitos de evolução. |

O histórico detalhado anterior foi preservado integralmente em
[`historico/documento-mestre-v3.md`](historico/documento-mestre-v3.md); commits e PRs continuam no Git.

## 10. DOCUMENTOS IMPORTANTES

| Documento | Função |
|---|---|
| **Documento Mestre** | [Fonte única de estado, prioridade e continuidade](DOCUMENTO_MESTRE.md) |
| **Status Atual** | [Resumo operacional de uma página](STATUS_ATUAL.md) |
| **Operação pós-merge** | [Checklist obrigatório da REGRA 001](OPERACAO.md) |
| **Guia de deploy** | [Arquitetura, deploy, validação e rollback](DEPLOY_GUIDE.md) |
| **Governança de desenvolvimento** | [Comitê de Arquitetura, Sprint Brief, decisões e Definition of Done](GOVERNANCA_DESENVOLVIMENTO.md) |
| **Enterprise Readiness** | [Baseline oficial baseada em evidências](ENTERPRISE_READINESS.md) |
| **Sprint 0.1** | [Brief da Auditoria Enterprise](sprints/SPRINT_0_1_ENTERPRISE_READINESS.md) |
| **Sprint 0.3** | [Brief de backup e restore isolado](sprints/SPRINT_0_3_BACKUP_RESTORE_READINESS.md) |
| **Prontidão de restore** | [Diagnóstico, procedimento, evidências e RPO/RTO propostos](ops/backup-restore-readiness.md) |
| **Dívida técnica** | [Achados priorizados da auditoria](TECH_DEBT.md) |
| **Roadmap** | [Horizontes estratégicos](roadmap/README.md) |
| **Dashboard Saúde** | [Estado e operação do módulo](dashboard-saude-plataforma.md) |
| **Arquitetura** | [Limites e topologia técnica](architecture/README.md) |
| **ADR** | [Índice de decisões arquiteturais](adr/README.md) |
| **Investigação UltraFV3** | [Identidade 5050×4484](investigations/ultrafv3-partner-identity-5050-4484.md) e [fluxo ERP→CRM](investigations/investigacao-erp-5050-fluxo-completo.md) |

### Governança desta fonte

- Atualizar a data, o responsável, “Onde paramos”, módulos, incidentes e `STATUS_ATUAL.md` em toda PR relevante.
- Registrar somente grandes entregas no changelog; o Git preserva o detalhe.
- Não apagar histórico: mover versões substituídas para `docs/historico/` e ligar a partir daqui.
- Revisar links e fatos a cada deploy. Campos não comprovados permanecem explicitamente “não comprovado”.

## Adendo — gate obrigatório de schema (31/07/2026)

O deploy permanece bloqueado até revisão e execução separada do schema apply. Produção não deve
executar `prisma db push`; o primeiro cutover usa somente a migration aditiva versionada, preserva
todas as `incident_*` e exige evidência por SHA antes do cutover. As imagens de `a2daeb5...` foram
construídas, não publicadas, e o banco recuperado continua preservado. Não houve deploy nesta mudança
e INC-5050-4484 permanece em homologação. Processo e riscos estão na
[auditoria de transição](investigations/production-schema-transition-july-2026.md).

## Decisão permanente: autoridade runtime × migration (01/08/2026)

A tentativa controlada no SHA `6041ddac...` falhou com segurança no primeiro `CREATE TYPE`: a role
runtime não possui `CREATE` em `public`. Nada persistiu, nenhuma migration ou cutover ocorreu e as
oito `incident_*` foram preservadas. O apply passa a manter `DATABASE_URL` para Prisma e leituras,
usando `docker exec --user postgres` no container PostgreSQL já validado somente durante a migration
transacional e verificações administrativas mínimas. É proibido conceder DDL ao runtime, trocar
owners ou expor credenciais/portas. O estágio continua 🔵 PR, com schema pendente e incidente aberto.
Veja [ADR 002](adr/002-runtime-migration-authority-separation.md) e a
[auditoria](investigations/production-schema-transition-july-2026.md).
# Adendo 4.1 — Sprint 0.6: arquitetura oficial para Multi-Tenancy

Em 02/08/2026, a auditoria documental da Sprint 0.6 concluiu que o Gest-o permanece single-tenant.
Dos 27 models Prisma, somente os quatro de Communications carregam `tenantId` parcial; não existe
entidade `Tenant`, membership, contexto autenticado, repository, RLS ou isolamento completo de
consultas, caches, jobs, logs, JWT e UltraFV3. A comercialização como multiempresa continua
bloqueada.

O inventário, riscos, estratégia expand/backfill/contract, compatibilidade, rollout, rollback e
roadmap 1.0A–1.0F estão em [`TENANCY_ASSESSMENT.md`](TENANCY_ASSESSMENT.md). A
[ADR 003](adr/003-shared-schema-tenant-boundary.md) propõe schema PostgreSQL compartilhado com
isolamento por linha, `Tenant`/memberships, chaves compostas, data-access obrigatório e RLS
defensiva. Ela deve ser aceita pelo Comitê antes da Sprint 1.0.

Este adendo não implementa tenancy, não cria migration, não altera APIs/banco/regras, não executa
Docker/deploy e não presume produção. Incidentes e débitos mantêm seus estados vigentes.

## ADENDO SPRINT 1.0B.1-OP — SOMENTE OPERAÇÃO FUTURA

A operação do control plane foi separada em preview, DDL administrativo, dry-run e DML administrativo, com registry fechado, imagem/SHA pinados e provas distintas. A PR não executou nenhuma etapa em produção e não integra tenancy ao runtime. O gate e as limitações estão no [Brief 1.0B.1-OP](sprints/SPRINT_1_0B_1_OP_CONTROL_PLANE_OPERATION.md); Multiempresa permanece 🔴.
