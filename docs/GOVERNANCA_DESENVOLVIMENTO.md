# Governança de Desenvolvimento do Gest-o

> **Status:** norma permanente<br>
> **Versão:** 1.0<br>
> **Vigência:** 01/08/2026<br>
> **Autoridade:** complementar ao [Documento Mestre](DOCUMENTO_MESTRE.md)<br>
> **Escopo:** produto, código, dados, infraestrutura, documentação, investigação e operação

Este documento institucionaliza o Comitê de Arquitetura e o ciclo de entrega do Gest-o. Ele define
**como** o trabalho nasce, é decidido, implementado, validado e encerrado. O Documento Mestre
continua sendo a fonte única do estado, das prioridades e dos gates do produto; ADRs registram o
porquê de decisões duradouras; investigações preservam hipóteses e evidências; runbooks governam a
execução operacional.

Em caso de conflito, prevalecem, nesta ordem: segurança e preservação de dados; Documento Mestre;
ADR aceita aplicável; esta norma; documentação especializada. A divergência deve bloquear a
implementação até que as fontes oficiais sejam reconciliadas na mesma Pull Request (PR).

## 1. Princípios inegociáveis

1. Velocidade não prevalece sobre estabilidade, segurança ou qualidade.
2. Toda mudança deve ser rastreável, observável, testável, reversível e compatível com o futuro.
3. Evidência objetiva prevalece sobre memória, hipótese, interface visual ou estado do Git local.
4. Nenhuma funcionalidade duplicada ou padrão paralelo será introduzido sem decisão explícita.
5. A menor alteração compatível que resolva o problema é preferida.
6. Segredos, dados pessoais e dados comerciais sensíveis não entram em código, logs ou evidências.
7. Multiempresa exige isolamento explícito; enquanto tenancy estiver bloqueada no Documento
   Mestre, nenhuma abstração parcial poderá ser apresentada como suporte multi-tenant.
8. Merge, deploy e produção são estados distintos. A promoção obedece à REGRA 001 do Documento
   Mestre e depende de evidência.
9. Documentação faz parte do produto e da Definition of Done (DoD).
10. Uma falha de gate interrompe a promoção; ela nunca é contornada silenciosamente.

## 2. Comitê de Arquitetura

O Comitê é uma função permanente de governança. Uma pessoa pode exercer mais de um papel, mas a
revisão deve considerar todas as perspectivas abaixo e registrar quem aprovou as decisões de alto
risco.

| Papel | Responsabilidade mínima na revisão |
|---|---|
| Product Manager / Produto SaaS | problema, valor, prioridade, escopo, comercialização e métricas de sucesso |
| Analista de Requisitos | regras, atores, cenários, critérios de aceite, exceções e rastreabilidade |
| Arquiteto de Software / Plataforma | limites, contratos, dependências, compatibilidade, escala e decisões duradouras |
| Segurança | autenticação, autorização, isolamento, ameaças, dados, segredos e menor privilégio |
| DevOps / Operação | CI/CD, configuração, deploy, rollback, capacidade, runbooks e resposta a falhas |
| DBA PostgreSQL | modelo, migrations, locks, integridade, backup, restauração e performance de consultas |
| QA | estratégia de testes, regressão, evidência, ambientes e qualidade não funcional |
| UI/UX | jornada, acessibilidade, consistência, estados de erro, responsividade e clareza |
| Revisor de código | simplicidade, padrões oficiais, legibilidade, segurança e cobertura de testes |
| Documentação técnica | coerência das fontes oficiais, links, operação, changelog e continuidade |
| Escalabilidade / Multiempresa | limites, particionamento lógico, isolamento, concorrência e crescimento |
| Observabilidade | logs sanitizados, métricas, traces, alertas, SLOs e diagnóstico pós-deploy |

### 2.1 Quórum proporcional ao risco

- **Baixo risco:** autor e revisor competente, com checklist completo.
- **Médio risco:** Produto, Arquitetura e QA; incluir o especialista da área afetada.
- **Alto ou crítico:** Produto, Arquitetura, Segurança, Operação, QA e especialista de dados quando
  houver impacto no PostgreSQL. Deploy e rollback exigem aprovação humana identificada.
- Incidente, autenticação/autorização, dados destrutivos, schema, tenancy, integração externa ou
  indisponibilidade potencial nunca são classificados como baixo risco.

Ausência de um papel não autoriza ignorar sua perspectiva. A lacuna deve ser registrada como risco,
com responsável e prazo, ou bloquear a entrega quando comprometer um gate.

## 3. Como uma Sprint nasce

### 3.1 Intake obrigatório

Antes de analisar ou implementar, ler, nesta ordem:

1. [`STATUS_ATUAL.md`](STATUS_ATUAL.md);
2. [`DOCUMENTO_MESTRE.md`](DOCUMENTO_MESTRE.md);
3. [`OPERACAO.md`](OPERACAO.md);
4. [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md);
5. índice e ADRs aplicáveis em [`adr/`](adr/README.md);
6. investigações relacionadas;
7. runbooks relacionados.

Depois, registrar no Sprint Brief:

- branch, `HEAD`, working tree e relação conhecida com `main`;
- últimas PRs e decisões relacionadas, quando a fonte estiver acessível;
- incidentes abertos e gates que afetam a proposta;
- padrões ou soluções semelhantes já existentes;
- conflito, duplicação ou lacuna documental encontrada;
- impacto em produção e condição de rollback.

“Não acessível” ou “não comprovado” é um resultado válido e deve ser explícito. Nunca se deve inferir
o estado remoto, da VPS ou de produção pelo checkout local.

### 3.2 Sprint Brief obrigatório

Nenhuma Sprint ou incremento começa sem um Sprint Brief revisável, em issue, documento versionado
ou descrição da PR. O Brief deve existir **antes da primeira alteração funcional** e conter:

```markdown
# Sprint Brief — <título>

## Objetivo
Resultado verificável a alcançar.

## Problema
Comportamento atual, pessoas afetadas e evidências.

## Justificativa
Valor para produto/operação e aderência ao Documento Mestre.

## Critérios de sucesso
Métricas ou provas que demonstram o resultado.

## Fora do escopo
Itens explicitamente não incluídos.

## Dependências
Sistemas, decisões, pessoas, dados, ambientes e gates prévios.

## Riscos
Probabilidade, impacto, mitigação, responsável e risco residual.

## Critérios de aceite
Cenários objetivos, incluindo autorização, erro e não regressão.

## Plano de testes
Testes automatizados, integração, regressão, segurança, performance e smoke.

## Plano de rollback
Gatilhos, passos, responsável, dados afetados, validação e tempo estimado.

## Documentação obrigatória
Fontes oficiais que serão criadas ou atualizadas.
```

### 3.3 Gate de autorização

A Sprint só entra em implementação quando:

- está alinhada à prioridade e aos bloqueios do Documento Mestre;
- não duplica capacidade existente;
- critérios de aceite e testes são executáveis;
- riscos alto/críticos têm mitigação e aprovador;
- rollback é tecnicamente possível ou a irreversibilidade foi explicitamente aprovada;
- dependências estão disponíveis ou separadas por feature flag/fallback seguro;
- impacto de Enterprise Readiness foi avaliado.

## 4. Decisões arquiteturais

### 4.1 Quando criar uma ADR

Criar ADR para decisão duradoura, transversal ou de alto custo de reversão, incluindo:

- mudança de limites de domínio, fonte de verdade, contrato público ou integração;
- tecnologia, protocolo, padrão de persistência ou topologia oficial;
- estratégia de tenancy, identidade, autorização, migration ou consistência;
- trade-off não óbvio de segurança, disponibilidade, performance ou escalabilidade;
- exceção deliberada a um padrão oficial.

Não criar ADR para correção local, implementação direta de decisão já aceita, investigação sem
veredito, procedimento operacional ou preferência de estilo. Esses conteúdos pertencem,
respectivamente, ao código/PR, investigação, runbook ou guia de contribuição.

### 4.2 Ciclo de uma ADR

1. Registrar contexto e forças, sem antecipar a solução.
2. Comparar ao menos a opção escolhida, alternativas viáveis e “não fazer”.
3. Avaliar segurança, dados, operação, custo, compatibilidade, escala e reversibilidade.
4. Documentar decisão, consequências positivas/negativas e riscos residuais.
5. Definir status: **proposta**, **aceita**, **rejeitada**, **substituída** ou **obsoleta**.
6. Obter quórum proporcional ao risco e vincular a implementação.
7. Atualizar o índice de ADRs e resumir a decisão no Documento Mestre quando ela mudar direção,
   estado, gate ou padrão oficial.

ADRs aceitas não são editadas para apagar contexto histórico. Uma nova decisão deve substituí-las
explicitamente, com links bidirecionais.

## 5. Processo de implementação

### 5.1 Antes da alteração

1. Concluir o intake e o Sprint Brief.
2. Mapear requisitos funcionais e não funcionais.
3. Modelar ameaças e revisar autorização/isolamento.
4. Identificar contratos, migrations e consumidores afetados.
5. Definir telemetria e sinais de sucesso/falha.
6. Planejar compatibilidade, rollout e rollback.
7. Confirmar testes e evidências esperadas.

### 5.2 Durante a alteração

- implementar o menor diff coerente;
- preservar padrões oficiais e compatibilidade retroativa;
- manter integrações externas no backend;
- usar migrations expand/contract quando houver coexistência de versões;
- impedir efeitos destrutivos implícitos, especialmente em produção;
- adicionar logs estruturados e sanitizados somente onde produzam diagnóstico acionável;
- manter testes próximos da regra alterada;
- atualizar documentação junto com o código, não após a entrega.

### 5.3 Revisão da PR

A descrição da PR deve conter: diagnóstico, impacto, riscos, alternativas consideradas, plano de
implementação, critérios de aceite, plano/evidência de testes, rollback e documentação atualizada.
O revisor confirma ainda:

- aderência ao Sprint Brief, Documento Mestre e ADRs;
- ausência de duplicação e expansão acidental de escopo;
- segurança, privacidade, isolamento e menor privilégio;
- compatibilidade de API, banco e integrações;
- tratamento de falhas, idempotência e concorrência;
- impacto operacional e de observabilidade;
- testes de regressão e legibilidade;
- atualização do estágio correto, sem declarar produção antecipadamente.

Comentários bloqueadores devem apontar o gate violado. Exceções precisam de justificativa,
responsável, prazo e registro no backlog; riscos críticos não admitem exceção informal.

## 6. Enterprise Readiness

Toda mudança recebe a marcação **evolui**, **neutra**, **regride** ou **não aplicável com
justificativa** em cada dimensão:

| Dimensão | Pergunta mínima |
|---|---|
| Arquitetura | respeita limites e reduz acoplamento/dívida? |
| Segurança | preserva menor privilégio, autorização e proteção de dados? |
| Banco | migration, integridade, lock, backup e restauração estão cobertos? |
| Deploy / rollback | rollout e reversão são seguros e ensaiáveis? |
| Observabilidade | sucesso, erro e saturação serão detectáveis sem PII? |
| Testes | regra, integração, regressão e falhas têm cobertura proporcional? |
| Performance / escala | custo, volume, concorrência e limites são conhecidos? |
| Multiempresa | dados, cache, jobs e integrações preservam isolamento? |
| Produto / UX | resolve o problema com jornada clara e acessível? |
| Documentação | fontes oficiais continuam coerentes e navegáveis? |
| Comercialização | planos, limites, suporte e custo operacional foram avaliados? |
| API pública / integrações | contratos, versionamento, idempotência e quotas são compatíveis? |
| Governança | responsáveis, evidências, aprovações e retenção estão definidos? |

Regressão não bloqueia automaticamente uma correção emergencial, mas exige aceite explícito,
mitigação, prazo e item de backlog. Quando existir `docs/ENTERPRISE_READINESS.md` (ou equivalente),
toda evolução ou regressão material deve atualizá-lo na mesma PR.

## 7. Testes e evidências

O plano deve ser proporcional ao risco e selecionar explicitamente:

- testes unitários das regras e limites;
- integração com PostgreSQL e contratos externos simulados;
- regressão de fluxos críticos e incidentes relacionados;
- autorização negativa, isolamento, validação de entrada e vazamento de dados;
- migration em base descartável representativa, com pré e pós-condições;
- concorrência, idempotência, volume e performance quando aplicáveis;
- acessibilidade, responsividade e estados de loading/vazio/erro na interface;
- build, typecheck, lint e verificações estáticas disponíveis;
- smoke pós-deploy e health checks do `OPERACAO.md`.

Cada evidência deve informar comando/cenário, ambiente, revisão, horário quando relevante e
resultado. Falha de ambiente é registrada como limitação, nunca promovida a sucesso. Testes em
produção devem ser read-only por padrão e seguir o runbook aplicável.

## 8. Deploy, rollback e observabilidade

### 8.1 Deploy

- seguir exclusivamente o `DEPLOY_GUIDE.md` e a REGRA 001;
- provar SHA, imagem, container, banco, stack e resposta externa;
- separar merge, publicação e validação nos estágios oficiais;
- exigir backup restaurável e janela quando dados/schema estiverem envolvidos;
- usar rollout progressivo ou feature flag quando o risco justificar;
- não misturar procedimentos oficiais e legados numa mesma publicação.

### 8.2 Rollback

O plano deve declarar gatilhos mensuráveis, último estado bom, comandos/runbook, impacto em dados,
compatibilidade do schema, responsável e validação pós-rollback. Reverter aplicação não implica
reverter banco. Restauração de backup é uma operação separada, destrutiva para dados posteriores, e
exige aprovação e ensaio isolado.

### 8.3 Observabilidade

Antes do merge, definir sinais de disponibilidade, erros, latência, saturação e resultado de
negócio. Alertas devem ter limiar, severidade, responsável e runbook. A PR deve indicar dashboards
ou consultas existentes reutilizados; uma nova métrica só é criada com cardinalidade, retenção e
privacidade avaliadas.

## 9. Documentação e rastreabilidade

Avaliar em toda entrega:

| Fonte | Atualizar quando |
|---|---|
| `STATUS_ATUAL.md` | mudar etapa vigente, bloqueador, incidente, próximo passo ou evidência operacional |
| `DOCUMENTO_MESTRE.md` | mudar estado, prioridade, direção, gate, módulo, incidente ou padrão oficial |
| `OPERACAO.md` | mudar verificação pós-merge ou critério operacional da REGRA 001 |
| `DEPLOY_GUIDE.md` | mudar topologia, build, deploy, configuração, validação ou rollback |
| ADR | houver nova decisão duradoura conforme a seção 4 |
| Investigação | surgirem hipótese, evidência, veredito ou risco ainda não consolidado |
| Runbook | mudar procedimento humano repetível ou resposta a incidente |
| Changelog executivo | houver grande entrega, decisão ou alteração operacional material |
| Enterprise Readiness | houver evolução/regressão material nas dimensões da seção 6 |

Atualizações devem dizer o que é fato, o que é hipótese e o que não foi comprovado. Links quebrados,
status contraditórios ou instruções inseguras bloqueiam a conclusão.

## 10. Definition of Done

Uma entrega só está pronta quando todos os itens aplicáveis estão comprovados:

- [ ] Sprint Brief aprovado e escopo respeitado.
- [ ] Critérios de aceite atendidos.
- [ ] Testes e regressões aprovados, com evidências.
- [ ] Segurança, privacidade e menor privilégio revisados.
- [ ] Banco, migrations e integridade validados.
- [ ] Performance, escala e multiempresa avaliadas.
- [ ] Deploy e rollback definidos e, quando exigido, ensaiados.
- [ ] Observabilidade e resposta a falhas disponíveis.
- [ ] UX e acessibilidade revisadas quando houver interface.
- [ ] Documentos oficiais e changelog atualizados quando aplicável.
- [ ] ADR criada ou atualizada somente quando houver decisão arquitetural.
- [ ] Dívidas, riscos residuais, responsáveis e prazos registrados.
- [ ] Revisão de código aprovada.
- [ ] Para produção, REGRA 001 integralmente concluída.

Se um item não se aplica, a justificativa deve ser registrada. “Depois ajustamos”, teste manual sem
evidência ou merge aprovado não substituem a DoD.

## 11. Recomendações formais do CTO Virtual

Ao identificar risco fora do escopo, o Comitê não modifica código automaticamente. Ele registra no
backlog uma recomendação com o seguinte contrato:

```markdown
### REC-<ano>-<sequencial> — <título>
- **Classificação:** Arquitetura | Segurança | Performance | Produto | Banco | DevOps | UX |
  Comercial | Governança
- **Severidade:** Crítica | Alta | Média | Baixa
- **Fundamentação:** fonte oficial e trecho/decisão aplicável; marcar explicitamente toda inferência
- **Consequências:** riscos de não agir
- **Recomendação:** resultado a incluir no backlog, sem implementação implícita
- **Sprint sugerida:** sprint/gate recomendado
- **Dependências:** requisitos e decisões anteriores
- **Responsável e prazo de triagem:** pessoa/papel e data
```

Recomendação não substitui Sprint Brief, ADR, incidente ou aprovação. Item crítico deve ser triado
antes de novo deploy relacionado; item alto, antes da próxima Sprint do domínio.

## 12. Governança de mudanças desta norma

Alterações editoriais podem ocorrer por PR comum. Mudanças de autoridade, gates, quórum, DoD ou
hierarquia documental exigem revisão do Comitê e registro no changelog executivo do Documento
Mestre. Uma ADR só é necessária se a mudança também decidir arquitetura de produto/plataforma.

Esta norma deve ser revisada após incidente grave, mudança material no processo de entrega ou, no
máximo, a cada seis meses. A revisão deve verificar aderência real por amostragem de PRs, e não
apenas a existência de checklists.

## 13. Sprint Brief desta institucionalização

### Objetivo

Tornar o método de governança explícito, único, navegável e reutilizável em todas as Sprints.

### Problema e justificativa

As regras estavam parcialmente distribuídas no Documento Mestre e em documentos históricos, sem um
contrato operacional completo para nascimento da Sprint, Comitê, ADR, revisão e DoD. A consolidação
reduz interpretações divergentes sem alterar arquitetura ou produção.

### Critérios de sucesso e aceite

- documento normativo criado e referenciado pelo Documento Mestre;
- template completo de Sprint Brief disponível;
- ciclo de ADR, matriz Enterprise Readiness e DoD definidos;
- papéis, gates, evidências, rollback e atualização documental explícitos;
- links Markdown locais válidos.

### Fora do escopo e dependências

Não altera código, CI/CD, banco, infraestrutura, produção, incidentes ou prioridades. Depende das
regras vigentes no Documento Mestre, Operação, Deploy Guide e ADRs aceitas.

### Riscos

O principal risco é governança apenas documental. A mitigação é exigir o Brief e a DoD nas PRs e
revisar aderência por amostragem. Não há risco de runtime, dados ou indisponibilidade.

### Plano de testes e rollback

Validar links, formatação e coerência com as fontes oficiais; revisar o diff. O rollback é reverter
esta PR e suas referências, sem efeito em aplicação ou dados.

### Documentação obrigatória

Este documento, Documento Mestre, Status Atual e changelog executivo.

## 14. Recomendação inaugural

### REC-2026-001 — Baseline de Enterprise Readiness

- **Classificação:** Governança
- **Severidade:** Média
- **Fundamentação:** esta norma exige avaliação em 17 dimensões, mas não há
  `docs/ENTERPRISE_READINESS.md` nem equivalente identificado no inventário atual. A conclusão de
  que uma baseline comparável facilita acompanhar evolução e regressão é **inferência técnica**.
- **Consequências:** avaliações ficam dispersas em PRs, dificultando comparação, priorização e
  demonstração de maturidade para comercialização enterprise.
- **Recomendação:** criar no backlog uma Sprint documental para definir baseline, evidências,
  responsáveis, periodicidade e critérios de maturidade, sem atribuir notas sem prova.
- **Sprint sugerida:** primeira Sprint de governança após o encerramento dos bloqueadores P0 atuais.
- **Dependências:** Documento Mestre estabilizado, inventário de arquitetura/operação e responsáveis
  pelas dimensões designados.
- **Responsável e prazo de triagem:** Comitê de Arquitetura, no planejamento da próxima Sprint
  elegível.
