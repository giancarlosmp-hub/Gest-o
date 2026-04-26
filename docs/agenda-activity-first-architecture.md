# Demetra Agro Performance CRM — Agenda Activity-First (Blueprint v1)

## 1) Objetivo desta PR

Iniciar uma **reestruturação arquitetural e visual não destrutiva** da Agenda para torná-la a **central operacional do CRM**, mantendo:

- APIs atuais em funcionamento;
- modelos de banco atuais sem migração nesta fase;
- comportamento existente de Agenda, Atividades, Roteiros, Check-in GPS e Follow-ups.

> Escopo desta entrega: **documentação técnica + plano de evolução gradual**.

---

## 2) Diagnóstico do estado atual (as-is)

## 2.1 Módulos e domínios sobrepostos

Hoje o domínio operacional está fragmentado entre:

- `Agenda` (eventos e roteiros);
- `Atividades` (execução comercial);
- `Roteiros` (embutidos como tipo de evento de agenda);
- `Check-in GPS` (embutido em paradas de roteiro e também em atividade);
- `Follow-ups` (aparecem em oportunidades, agenda e atividades).

Consequência prática: múltiplas entradas para ações parecidas (planejar, executar, concluir, reagendar), com semânticas parcialmente duplicadas.

## 2.2 Entidades existentes mapeadas

### Banco (Prisma)

- `Activity` já existe e possui muitos campos de execução (dueDate/date, done, checkIn*, vínculo com cliente/oportunidade/agenda).  
- `AgendaEvent` existe como evento de agenda com tipo específico (`reuniao_online`, `reuniao_presencial`, `roteiro_visita`, `followup`).  
- `AgendaStop` representa paradas logísticas de `AgendaEvent` (com check-in/check-out e resultado de visita).  
- `Opportunity` mantém `followUpDate` próprio (lógica comercial de pipeline paralela ao operacional diário).  
- `TimelineEvent` recebe eventos derivados tanto de agenda quanto de execução de atividades.

## 2.3 Contratos e aliases legados

Há um esforço claro de compatibilidade já ativo:

- aliases de tipo (`follow_up` -> `followup`);
- payload híbrido agenda (`startDateTime`/`endDateTime` e `startsAt`/`endsAt`);
- rotas duplicadas para compatibilidade (`/agenda`, `/agenda/events`, `/agenda-events/:id/...`).

Isso é positivo para migração gradual, mas aumenta complexidade acidental se não houver uma camada canônica.

---

## 3) Duplicidades e inconsistências identificadas

## 3.1 Duplicidade de conceito por contexto

1. **Follow-up** aparece em três lugares:
   - `Opportunity.followUpDate`;
   - `AgendaEvent.type = followup`;
   - `Activity.type = followup/follow_up`.

2. **Visita** aparece como:
   - atividade manual (`Activity.type = visita`);
   - parada de roteiro (`AgendaStop`), que pode gerar atividade automática.

3. **Status operacional** aparece em modelos diferentes:
   - agenda (`planned/completed/cancelled`, mapeado para `agendado/realizado/vencido`);
   - atividade (`done` + cálculo de vencido por `dueDate`).

## 3.2 Taxonomia de tipos não unificada

- `ActivityType` tem tipos legados/semelhantes (`followup` e `follow_up`, `proposta_enviada` e `envio_proposta`).
- `AgendaEventType` é restrito a 4 tipos e não cobre toda a rotina executável.
- Front-end e back-end usam normalizações ad-hoc para manter consistência.

## 3.3 UX fragmentada

- Página de Agenda oferece múltiplas visualizações (diária/semanal/mensal/lista), criação de agenda e criação de roteiro no mesmo fluxo, além de execução de parada e geração de follow-up/oportunidade.
- Página de Atividades também concentra criação/execução/reagendamento/duplicação/edição.
- Resultado: vendedor alterna entre duas “centrais operacionais”.

---

## 4) Arquitetura alvo (to-be): Agenda como Central Activity-First

## 4.1 Princípio norteador

A entidade canônica da operação diária passa a ser:

## **Activity (atividade)**

Tipos canônicos alvo:

- visita
- follow-up
- ligação
- reunião
- WhatsApp
- tarefa
- roteiro (apenas como agrupador logístico)

## 4.2 Regra estrutural de roteiro

**Roteiro deixa de ser módulo independente** e passa a ser:

- um **agrupador logístico** de atividades do tipo **visita**.

Exemplo:

- Roteiro Oeste PR
  - visita Copagril
  - visita Lar
  - visita Primato

Cada visita é uma `Activity` autônoma (com SLA, responsável, resultado, check-in, etc.), e o roteiro apenas organiza sequência/logística.

## 4.3 Modelo conceitual unificado (sem alterar banco nesta fase)

Camada de domínio (view model) proposta:

- `ActivityCore` (canônico):
  - identidade, tipo, status operacional, data planejada/execução;
  - contexto comercial (cliente, oportunidade, responsável);
  - contexto de execução (resultado, duração, observações, geolocalização);
  - rastreabilidade (origem: manual, agenda, parada de roteiro, automação).

- `ActivityGroup` (agrupadores):
  - `kind = route` para roteiros;
  - metadados logísticos (ordem, janela, distância estimada futura).

- `OperationalTimelineItem` (componente de UI):
  - item único renderizável (atividade ou agrupador), com densidade adaptativa desktop/mobile.

> Importante: nesta PR, esse modelo é apenas especificação arquitetural para orientar refatoração incremental.

---

## 5) Fluxos operacionais alvo

## 5.1 Fluxo vendedor (day-in-the-life)

1. Abrir Agenda (central operacional).
2. Ver bloco “Hoje” com prioridade:
   - vencidas;
   - próximas 2h;
   - roteiros do dia.
3. Executar atividades direto na timeline:
   - check-in/check-out quando tipo visita;
   - registro de resultado e próximo passo.
4. Converter resultado em ação imediata:
   - gerar follow-up;
   - gerar oportunidade;
   - reagendar.
5. Encerrar dia com visão de:
   - planejado x realizado;
   - pendências transferidas.

## 5.2 Fluxo gerente

1. Abrir Agenda com escopo de equipe.
2. Visualizar painéis de execução:
   - cobertura diária por vendedor;
   - roteiros ativos e paradas pendentes;
   - follow-ups vencidos por carteira.
3. Aplicar filtros operacionais (não apenas por tipo):
   - risco, atraso, sem check-in, sem próximo passo.
4. Atuar por exceção:
   - redistribuição de carga;
   - alertas e coaching.

---

## 6) Estratégia de compatibilidade retroativa

## 6.1 Princípios

- **API-first compatibility:** manter endpoints e payloads atuais.
- **Dual-read / single-write gradual:** novos componentes podem ler view-model unificado, mas escrita continua nos endpoints atuais até fase de convergência.
- **Feature flags por tela/bloco:** habilitar gradualmente sem big bang.

## 6.2 Contratos legados preservados (fase atual)

- manter rotas atuais de agenda, atividades e check-in;
- manter aliases de tipo (`follow_up` etc.);
- manter compatibilidade de campos `startsAt/startDateTime`, `endsAt/endDateTime`;
- manter geração automática de `Activity` a partir de parada de roteiro concluída.

## 6.3 Façade de unificação (próxima fase)

Criar camada de aplicação (sem breaking):

- `OperationalAgendaService` (API interna) para montar feed unificado;
- mapeadores:
  - `AgendaEvent -> ActivityCore|ActivityGroup`
  - `AgendaStop -> ActivityCore (visita)`
  - `Activity -> ActivityCore`
- normalizador único de tipo/status para eliminar espalhamento de regras.

---

## 7) Análise UX/UI (desktop + mobile)

## 7.1 Agenda desktop (estado atual)

Pontos fortes:

- múltiplas visualizações (diária/semanal/mensal/lista);
- resumo de reuniões/roteiros/follow-ups/vencidos;
- filtros de período e vendedor.

Pontos críticos:

- alta densidade de cards e ações contextuais dispersas;
- alternância entre blocos sem hierarquia clara de prioridade;
- coexistência de “agenda” e “roteiro” no modal sem explicitar relação Activity-first.

## 7.2 Agenda mobile

Pontos fortes:

- componentes “mobile-modal-shell/panel/footer” padronizados;
- ações rápidas de execução presentes.

Pontos críticos:

- excesso de modais encadeados (resultado, follow-up, oportunidade, reagendamento);
- custo cognitivo alto para concluir uma visita fim-a-fim;
- risco de “perda de contexto” ao alternar entre itens.

## 7.3 Modal de nova agenda e modal de roteiro

Recomendação:

- convergir para **“Nova atividade”** com seletor de tipo;
- quando tipo = visita com agrupamento logístico, habilitar seção de roteiro;
- manter compatibilidade visual dos modais atuais por trás de flag até estabilização.

## 7.4 Timeline operacional

Direção recomendada (enterprise SaaS):

- feed único por dia com trilhos visuais:
  - `Atrasadas`
  - `Hoje`
  - `Próximas`
  - `Concluídas`
- itens com microações inline (executar, reagendar, converter em follow-up/oportunidade).

## 7.5 Densidade visual e hierarquia UX

- reduzir blocos redundantes de resumo;
- destacar “próxima melhor ação” por item;
- padronizar badges (tipo + status + SLA) com semântica única;
- priorizar legibilidade móvel (alvos de toque maiores, menos colunas, mais progressivo).

## 7.6 Transformação visual: timeline/calendar/pipeline

Estratégia híbrida sugerida:

- **Timeline operacional (default)**: foco execução diária.
- **Calendar (toggle)**: visão de capacidade e conflitos.
- **Pipeline operacional (gerente)**: visão por status/SLA para gestão por exceção.

---

## 8) Componentes e camadas candidatas à refatoração

## 8.1 Front-end

1. `apps/web/src/pages/AgendaPage.tsx`
   - decompor em:
     - `AgendaHeader`
     - `OperationalFilters`
     - `OperationalTimeline`
     - `RouteGroupCard`
     - `ActivityExecutionDrawer`.

2. `apps/web/src/pages/ActivitiesPage.tsx`
   - reduzir sobreposição com Agenda;
   - transformar em visão especializada (backoffice/histórico), não central diária.

3. `apps/web/src/constants/activityTypes.ts`
   - centralizar taxonomia canônica + aliases legados em uma única fonte de verdade.

## 8.2 Back-end

1. `apps/api/src/routes/crudRoutes.ts`
   - extrair regras de agenda/atividade para serviços de domínio;
   - remover acoplamento de normalizações espalhadas em handlers.

2. Camada nova sugerida:
   - `apps/api/src/services/operational-agenda/*`
   - mapeadores de compatibilidade e view model unificado.

## 8.3 Shared contract

1. `packages/shared/src/index.ts`
   - separar tipos canônicos de tipos legados;
   - publicar enum “presentation-safe” para Agenda central.

---

## 9) Plano de evolução por fases (sem quebra)

## Fase 0 — Preparação (esta PR)

- documentação arquitetural;
- inventário de entidades/duplicidades;
- desenho de fluxos vendedor/gerente;
- estratégia de compatibilidade.

## Fase 1 — Camada de unificação sem migrar banco

- criar `OperationalAgendaService` no backend;
- entregar endpoint de leitura agregada (novo, opcional);
- manter escrita nos endpoints atuais.

## Fase 2 — UI Activity-first incremental

- introduzir timeline operacional na Agenda sob feature flag;
- manter telas atuais coexistindo;
- medir adoção e tempo de execução por tarefa.

## Fase 3 — Convergência de criação/execução

- unificar “Nova agenda”, “Novo roteiro” e “Nova atividade” em fluxo único;
- roteiros passam a ser claramente agrupadores de visitas.

## Fase 4 — Racionalização de legado

- deprecar aliases e fluxos redundantes somente após telemetria e estabilidade;
- planejar migração de banco (se necessário) com rollout controlado.

---

## 10) KPIs de sucesso da reestruturação

- redução do tempo médio para registrar uma visita completa;
- aumento da taxa de atividades concluídas no mesmo dia;
- redução de follow-ups vencidos;
- aumento de aderência de check-in em visitas;
- redução de navegação cruzada Agenda <-> Atividades para tarefas do dia.

---

## 11) Riscos e mitigação

1. **Risco:** regressão em fluxos críticos de campo.  
   **Mitigação:** feature flags + testes manuais por perfil (vendedor/gerente).

2. **Risco:** inconsistência de status entre Agenda e Activity.  
   **Mitigação:** normalizador único + testes de contrato.

3. **Risco:** sobrecarga cognitiva com muitas visões.  
   **Mitigação:** definir timeline como default e calendar/pipeline como alternativas explícitas.

---

## 12) Decisões arquiteturais já firmadas nesta preparação

- Não haverá alteração de schema de banco nesta etapa.
- Não haverá remoção de endpoints ou funcionalidades existentes nesta etapa.
- A centralização será **progressiva**, com compatibilidade retroativa como requisito mandatário.
- “Roteiro” será reposicionado como **agrupador logístico** de atividades de visita, preservando cada visita como atividade individual.

---

## 13) Próximos passos recomendados (imediatos)

1. Aprovar este blueprint.
2. Criar épico técnico “Agenda Activity-first”.
3. Abrir PR 2 com:
   - `OperationalAgendaService` (read model agregado);
   - testes de contrato sem quebrar rotas existentes.
4. Abrir PR 3 com primeira versão da timeline operacional (feature flag).

