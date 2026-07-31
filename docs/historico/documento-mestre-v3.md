# Gest-o — Documento Mestre v3.0 (arquivo histórico)

> Cópia integral do Documento Mestre vigente até 31 de julho de 2026. Este arquivo é
> imutável e existe para preservar o histórico; a fonte de verdade atual é
> [`../DOCUMENTO_MESTRE.md`](../DOCUMENTO_MESTRE.md).

# Gest-o — Documento Mestre

- **Versão:** 3.0
- **Última atualização:** 31 de julho de 2026
- **Status:** referência executiva e técnica vigente

## Governança pós-deploy da identidade UltraFV3 (31/07/2026)

A regra aprovada de matching permanece inalterada. A governança passa a contar decisões por estratégia nos diagnósticos de execução e manter trilha permanente e transacional para mudanças de `Client.code`, sem registrar CPF/CNPJ completo. Consulte o [Guia Operacional](post-deploy/guia-operacional.md), o [Plano de Monitoramento](post-deploy/plano-monitoramento.md) e o [Plano Futuro de Unicidade](post-deploy/plano-unicidade-client-code.md).

> **Papel deste documento.** Este é o ponto de entrada para compreender o Gest-o, seu estado,
> direção e governança. Ele resume conhecimento consolidado e encaminha para as fontes
> especializadas; não substitui ADRs, runbooks, investigações, planos ou evidências.

## Navegação

1. [Visão Geral](#1-visão-geral)
2. [Missão do Produto](#2-missão-do-produto)
3. [Mapa Estratégico do Projeto](#3-mapa-estratégico-do-projeto)
4. [Estado Atual do Projeto](#4-estado-atual-do-projeto)
5. [Estado de Saúde do Projeto](#5-estado-de-saúde-do-projeto)
6. [Roadmap Estratégico](#6-roadmap-estratégico)
7. [Arquitetura](#7-arquitetura)
8. [Estado dos Módulos](#8-estado-dos-módulos)
9. [ADRs](#9-adrs)
10. [Runbooks](#10-runbooks)
11. [Investigações Técnicas](#11-investigações-técnicas)
12. [Registro Permanente de Conhecimento](#12-registro-permanente-de-conhecimento)
13. [Riscos Estratégicos](#13-riscos-estratégicos)
14. [Glossário](#14-glossário)
15. [Sprint Atual](#15-sprint-atual)
16. [Governança e Definition of Done](#16-governança-e-definition-of-done)
17. [Inventário do Trabalho Iniciado e Não Concluído](#17-inventário-do-trabalho-iniciado-e-não-concluído)
18. [Backlog Priorizado](#18-backlog-priorizado)
19. [Incidentes Resolvidos](#19-incidentes-resolvidos)
20. [Procedimentos Pós-Deploy](#20-procedimentos-pós-deploy)
21. [Critérios de Encerramento de Incidentes](#21-critérios-de-encerramento-de-incidentes)
22. [Evoluções Futuras](#22-evoluções-futuras)
23. [Regra de Atualização deste Guia](#23-regra-de-atualização-deste-guia)

---

## 1. Visão Geral

O **Gest-o** é uma plataforma SaaS de gestão comercial que concentra relacionamento com clientes,
agenda de campo, oportunidades, vendas e integrações operacionais em uma experiência única. Seu
núcleo atual atende a operação comercial da Demetra Agronegócios, com vocação para evoluir de CRM
interno para uma plataforma multiempresa e um ecossistema de negócios.

O produto resolve a fragmentação de dados e rotinas comerciais: reúne carteira, histórico,
atividades, pipeline e contexto de ERP; melhora a coordenação entre vendedor e gestão; e torna
processos críticos rastreáveis. Seu público-alvo imediato são equipes comerciais, gestores e
administradores. No horizonte estratégico, inclui empresas participantes, parceiros, fornecedores
e clientes do ecossistema.

Sua proposta de valor é oferecer **continuidade operacional e visão comercial integrada**, reduzindo
retrabalho e dependência de controles dispersos. Seus diferenciais pretendidos são:

- agenda orientada a atividades como centro do trabalho comercial;
- combinação do contexto de CRM com dados e fluxos do ERP;
- rastreabilidade de integrações e decisões operacionais;
- arquitetura preparada para canais, automação e inteligência assistida;
- documentação tratada como parte do produto e da governança.

## 2. Missão do Produto

### Curto prazo — consolidar a operação

Entregar um CRM interno confiável, seguro e aderente ao trabalho diário, consolidando clientes,
carteiras, agenda, atividades, oportunidades e pedidos integrados ao ERP. A prioridade é preservar
dados, estabilizar produção e tornar os fluxos críticos observáveis.

### Médio prazo — ampliar a gestão comercial

Transformar o núcleo de CRM em CRM e ERP comercial integrados, incorporando catálogo, pedidos,
financeiro, compras, estoque, fretes e comunicação omnichannel de forma incremental e governada.

### Longo prazo — formar um ecossistema

Evoluir para uma plataforma multiempresa, com marketplace, aplicativos e integrações que conectem
os participantes da cadeia. A expansão deve preservar isolamento, segurança, rastreabilidade e uma
fonte confiável de conhecimento.

## 3. Mapa Estratégico do Projeto

O mapa expressa **direção de evolução**, não datas, compromissos de entrega ou uma sequência rígida:

```text
CRM Interno
    ↓
CRM Comercial
    ↓
ERP Comercial
    ↓
Plataforma Multiempresa
    ↓
Marketplace
    ↓
Aplicativos
    ↓
Ecossistema Completo
```

Cada estágio amplia capacidades e público sem abandonar a confiabilidade do estágio anterior. O
detalhamento futuro de horizontes pertence a [`roadmap/`](roadmap/README.md).

## 4. Estado Atual do Projeto

### Resumo executivo

- **Estágio geral:** CRM interno/comercial funcional em consolidação, com integrações ERP e fundação
  omnichannel em evolução; ainda não é um ERP completo nem uma plataforma multiempresa.
- **Capacidades centrais:** autenticação e perfis, usuários, clientes e contatos, carteira comercial,
  agenda e atividades, oportunidades e itens, metas/KPIs, vendas, catálogo/preços, sincronização ERP,
  comunicações e base de conhecimento.
- **Arquitetura atual:** monorepo com SPA web, API REST e pacote de contratos compartilhados; a API
  concentra regras e integrações e persiste dados relacionais.
- **Ambientes conhecidos:** desenvolvimento local, preview por pull request e produção em VPS. A
  condição real de um ambiente deve sempre ser confirmada pelos mecanismos operacionais próprios.
- **Tecnologias principais:** React, Vite e TypeScript no frontend; Node.js, Express e TypeScript no
  backend; Prisma e PostgreSQL na persistência; Docker Compose e Nginx na execução/publicação.
- **Infraestrutura:** serviços web, API e banco conteinerizados; proxy reverso na borda; automações de
  CI/deploy; volume persistente e rotinas defensivas de backup, saúde e reconciliação em produção.

Fontes especializadas: [README técnico](../README.md), [arquitetura](architecture/README.md),
[deploy de produção](deploy-production.md) e [configuração sensível do ERP](erp-production-env-setup.md).

## 5. Estado de Saúde do Projeto

**Situação geral: atenção controlada.** O núcleo possui capacidades reais e proteções operacionais,
mas a estabilidade depende da consolidação das integrações e da validação do estado efetivamente
implantado. As investigações e os documentos de recuperação demonstram evolução dos controles,
embora também revelem riscos que ainda exigem acompanhamento.

| Dimensão | Leitura executiva |
|---|---|
| Estabilidade | Aplicação funcional, com guardrails de banco, backup e deploy; sincronização ERP, divergência entre versões/ambientes e regressões de produção permanecem áreas sensíveis. |
| Riscos técnicos | Identidade e arquivamento de clientes na sincronização, concorrência de fontes de carteira, idempotência de pedidos, dependência de serviços externos e observabilidade de deploy. |
| Riscos organizacionais | Conhecimento operacional concentrado, necessidade de validação humana em produção e documentação especializada distribuída. |
| Dívida técnica relevante | Contratos legados na unificação de agenda/atividades, limitações aceitas da fundação omnichannel, lacunas de auditoria histórica e coexistência de documentos anteriores à estrutura oficial de ADRs. |
| Investigações críticas | Causa definitiva do arquivamento associado ao ERP 5050 e confirmação do estado/versionamento real de produção. |

Detalhes e evidências permanecem nas [investigações](investigations/) e nos
[registros de incidentes](incidents/), sem serem reproduzidos aqui.

## 6. Roadmap Estratégico

O roadmap é organizado por horizontes e capacidades. As prioridades abaixo são a sequência oficial
recomendada em 31/07/2026; datas e compromissos somente existem quando aprovados na Sprint Atual.
Planejamentos detalhados devem ser mantidos em [`roadmap/`](roadmap/README.md).

| Ordem / horizonte | Objetivo | Situação atual | Gate para avançar |
|---|---|---|---|
| 1 — agora | Estabilizar produção, identidade UltraFV3 e operação de deploy. | Em validação pós-incidente. | Evidência de estabilidade, backup restaurável, revisão implantada verificável e encerramento formal dos incidentes críticos. |
| 2 — agora | Concluir o CRM interno e a convergência Activity-First. | Núcleo funcional; contratos de agenda/atividades ainda sobrepostos. | Fluxos críticos sem regressão, migração compatível e documentação operacional atualizada. |
| 3 — próximo | Concluir o ciclo comercial ERP (catálogo, preços, pedido, retorno e reconciliação). | Parcial e sob estabilização. | Identidade, idempotência, auditoria, tratamento de falhas e aceite operacional comprovados. |
| 4 — próximo | Consolidar IA e Base de Conhecimento IA com categorias governadas. | Funcionalidade iniciada, porém sem governança/RAG maduros e com integração local não consolidada. | Permissões, curadoria, qualidade, limites de contexto, provider e capacidade de infraestrutura validados. |
| 5 — próximo | Levar a fundação Meta WhatsApp a um canal operacional governado. | Inbound fundacional implementado; produção, Inbox e outbound não concluídos. Facebook e Instagram ainda não integrados. | Gate de produção, tenancy, retenção, observabilidade e operação humana aprovados antes de outbound/automação. |
| 6 — posterior | Ampliar domínios ERP comercial: financeiro, compras, estoque e fretes. | Financeiro parcial; demais domínios planejados. | Fonte de verdade e contrato de cada domínio aprovados antes de implementação. |
| 7 — estratégico | Plataforma multiempresa. | Direção arquitetural, sem tenancy completa. | Isolamento de dados, identidade, autorização, billing e migração definidos. |
| 8 — longo prazo | Marketplace, aplicativos e ecossistema. | Visão futura. | Caso de negócio validado e fundação multiempresa operacional. |

## 7. Arquitetura

Em visão macro, o Gest-o adota um monorepo com três blocos: uma SPA para experiência de usuário,
uma API REST para regras de negócio e integrações, e um pacote compartilhado para contratos. A API
acessa o PostgreSQL por meio do Prisma e integra serviços externos pelo backend. Em execução
conteinerizada, Nginx atende o frontend e encaminha chamadas à API, enquanto o banco permanece na
rede interna.

### Topologia de produção recuperada confirmada

Na investigação operacional de 30 de julho de 2026 foram confirmados como alvos corretos a API
`gest-o-api-recovery-20260718`, o PostgreSQL `gest-o-db-clean-v2-20260717` e o database
`salesforce_pro`. A API acessa o PostgreSQL por Prisma usando a `DATABASE_URL` do próprio runtime;
nome de container, database, rede, volume e revisão implantada devem ser verificados em conjunto.
Containers, volumes ou databases de recuperação alternativos são fontes distintas até comparação
forense, mesmo quando seus nomes ou dados pareçam semelhantes.

As fronteiras detalhadas, diagramas e futuras visões devem residir em
[`docs/architecture`](architecture/README.md). Blueprints e decisões específicas continuam em suas
fontes, como a [arquitetura Agenda Activity-First](agenda-activity-first-architecture.md), a
[integração UltraFV3](erp-ultrafv3-integration-technical.md) e a
[fundação omnichannel](communications/secure-omnichannel-foundation.md).

### Arquitetura operacional vigente em produção

Após a recuperação de julho de 2026, a topologia efetivamente adotada em produção é:

| Componente | Identificação vigente | Papel operacional |
|---|---|---|
| API | `gest-o-api-recovery-20260718` | Executa a API REST, as regras de negócio e o acesso ao banco via Prisma. |
| PostgreSQL | `gest-o-db-clean-v2-20260717` | Banco configurado como persistência da API em produção. |
| Rede Docker | `gest-o_default` | Rede privada que permite a comunicação entre os containers, sem exigir exposição pública do PostgreSQL. |

A forma sanitizada da conexão configurada é
`postgresql://<credenciais-omitidas>@gest-o-db-clean-v2-20260717:5432/salesforce_pro?schema=public`.
Ela registra somente protocolo, destino, porta, banco e schema; usuário e senha não fazem parte deste
documento. O fluxo operacional é:

```text
requisição HTTP → gest-o-api-recovery-20260718 → Prisma/DATABASE_URL
                → gest-o_default → gest-o-db-clean-v2-20260717 → PostgreSQL/salesforce_pro
```

Os nomes acima descrevem o estado vigente e devem ser conferidos antes de uma intervenção. Os
demais containers PostgreSQL preservados após o incidente são ambientes de recuperação ou teste e
não devem ser confundidos com o banco atualmente configurado na API.

## 8. Estado dos Módulos

“Planejado” indica direção de produto, não implementação existente.

| Módulo | Objetivo | Estágio | Documentação relacionada |
|---|---|---|---|
| CRM | Centralizar clientes, contatos, carteira e histórico. | Funcional, em consolidação. | [Produto](product/README.md), [fluxo ERP–CRM](investigations/investigacao-erp-5050-fluxo-completo.md) |
| Agenda e atividades | Organizar execução diária e acompanhamento comercial. | Funcional; convergência Activity-First planejada. | [Blueprint Activity-First](agenda-activity-first-architecture.md) |
| Comercial | Gerir oportunidades, itens, pipeline, metas e vendas. | Funcional, com ciclo ERP em evolução. | [plano produtos/pedidos](erp-products-order-integration-plan.md), [testes de oportunidades](manual-test-opportunities.md) |
| ERP | Sincronizar cadastros e viabilizar pedidos no UltraFV3. | Integração parcial e sob estabilização. | [arquitetura técnica](erp-ultrafv3-integration-technical.md), [fluxo operacional](erp-operational-flow.md) |
| Financeiro | Incorporar contexto financeiro relevante à operação. | Parcial via dados integrados; domínio completo planejado. | [validação UltraFV3](ultrafv3-production-validation.md) |
| Compras | Apoiar o ciclo de aquisição. | Planejado. | [Roadmap](roadmap/README.md) |
| Estoque | Disponibilizar posição e movimentos necessários ao comercial. | Planejado. | [Roadmap](roadmap/README.md) |
| Omnichannel | Unificar contas, conversas, mensagens e webhooks com segurança. | Fundação implementada, com limitações e gates documentados. | [fundação segura](communications/secure-omnichannel-foundation.md), [architecture freeze](communications/architecture-freeze-2026-07-21.md) |
| Aplicativos | Levar jornadas prioritárias a experiências móveis dedicadas. | Planejado. | [Roadmap](roadmap/README.md) |
| Fretes | Apoiar cotação, contratação e acompanhamento logístico. | Planejado. | [Roadmap](roadmap/README.md) |
| Integrações | Conectar ERP, consulta de CNPJ e futuros serviços sem expor segredos. | Ativo, com expansão incremental. | [mapa UltraFV3](erp-ultrafv3-real-integration-map.md), [operação CNPJ](ops/cnpj-lookup.md) |
| IA | Assistir análise e trabalho comercial com controles no backend. | Base existente e integração local investigada; evolução não consolidada. | [diagnóstico Ollama](investigations/ollama-ai-integration-diagnosis.md) |
| Plataforma multiempresa e marketplace | Isolar organizações e conectar participantes. | Estratégico/planejado. | [Roadmap](roadmap/README.md) |

## 9. ADRs

ADRs registram decisões arquiteturais duradouras, com contexto, alternativas e consequências. Devem
ser usados quando uma escolha relevante altera limites, dependências, dados, segurança ou operação
e quando futuros mantenedores precisarem compreender **por que** ela foi adotada. A localização
oficial é [`docs/adr`](adr/README.md); este documento mantém apenas o resumo e a navegação.

### Decisões consolidadas em visão executiva

- a agenda deve convergir para uma central orientada a atividades, preservando compatibilidade com
  contratos legados durante a transição ([blueprint](agenda-activity-first-architecture.md));
- integrações com UltraFV3 devem passar pelo backend, possuir configuração controlada, persistência
  de execução e proteções contra duplicidade ([arquitetura técnica](erp-ultrafv3-integration-technical.md));
- a identidade de parceiros UltraFV3 distingue estabelecimentos por CPF/CNPJ completo e restringe
  fallback textual a registros sem documento ([ADR 001](adr/001-ultrafv3-partner-establishment-identity.md));
- a fundação omnichannel separa contas, conversas, mensagens e eventos de webhook, com segurança e
  gates explícitos antes da evolução ([architecture freeze](communications/architecture-freeze-2026-07-21.md));
- backups administrativos locais do PostgreSQL recuperado usam a identidade administrativa local e
  não dependem das credenciais da aplicação ([registro normativo legado](documento-mestre.md)).

Novas decisões devem ser criadas no diretório oficial; registros legados devem ser referenciados,
sem duplicação ou reclassificação silenciosa.

## 10. Runbooks

Runbooks são procedimentos executáveis e repetíveis para deploy, operação, diagnóstico, recuperação
e resposta a incidentes. Devem ser consultados **antes** de uma ação operacional ou quando uma
condição conhecida precisar ser diagnosticada; o Documento Mestre não reproduz seus comandos.

Pontos de entrada atuais:

- [auditoria de imagem candidata e ERP 5050](production-erp-5050-runbook.md);
- [coleta forense read-only do ERP 5050](runbooks/erp-5050-forensic.md);
- [deploy e diagnóstico de WhatsApp](operations/deploy-and-whatsapp-diagnostics.md);
- [backup](ops/backup.md), [PostgreSQL](ops/postgresql-access.md) e
  [autostart](ops/systemd-autostart.md);
- [recuperação final do incidente de produção](incidents/2026-07-19-final-recovery-runbook.md).

Procedimentos novos devem ser organizados em [`docs/runbooks`](runbooks/) ou [`docs/ops`](ops/), de
acordo com sua finalidade, e ligados aqui quando forem relevantes para a continuidade do projeto.

## 11. Investigações Técnicas

Investigações preservam hipóteses, método, evidências e conclusões; ficam em
[`docs/investigations`](investigations/). Em nível executivo, as frentes correntes são:

- **ERP 5050 e integridade de clientes:** determinar a origem e o comportamento do arquivamento,
  reativação e troca de carteira após sincronizações e recuperação;
- **confiabilidade de produção:** confirmar que versão, stack e dados efetivos correspondem ao estado
  esperado depois de deploys;
- **evolução de IA:** avaliar uma integração local segura, seus limites de infraestrutura e o melhor
  ponto de entrada no produto.

### ERP 5050

- **Objetivo:** explicar de forma reproduzível o conjunto de clientes arquivados associado ao código
  ERP 5050 e separar comportamento esperado, regressão e efeito da recuperação.
- **Situação atual:** causa definitiva ainda não provada; análise de código e fluxo foi consolidada.
  O runner forense foi homologado em produção para coleta de evidência operacional preservada.
- **Descobertas consolidadas:** existem múltiplos escritores do estado de arquivamento; identidade,
  representante/carteira e regras de reativação influenciam o resultado; a entidade de cliente não
  oferece toda a informação temporal necessária para atribuição histórica isolada.
- **Runner homologado:** a execução é estritamente read-only, usa o modo `docker-peer` e envia o SQL
  versionado ao `psql` por STDIN. Cada execução gera `manifest.json`, hashes SHA256 dos artefatos e
  saídas separadas; `stderr.txt` vazio integra o critério de sucesso. As evidências ficam em um
  diretório exclusivo sob `/root/gest-o-safe`.
- **Próximo passo:** reconciliar a evidência coletada com execuções e versão implantada e então
  registrar um veredito revisável.

#### Incidente de identidade de filiais UltraFV3 — parceiros 5050 e 4484

Em 30/07/2026, no ambiente relatado `gest-o-api-recovery-20260718` /
`gest-o-db-clean-v2-20260717`, o parceiro 5050 (COCAMAR CD, CNPJ
`79.114.450/0033-**`) foi associado ao cliente 4484 (COCAMAR SEDE, CNPJ
`79.114.450/0040-**`). Os logs registraram candidato único por identidade e update do `clientId` de
4484; o estado final não continha 5050, enquanto o perfil financeiro de 4484 carregava
`PARCEIRO_OUT=5050`.

A causa comprovada no código era o fallback por razão social+cidade+UF depois de falharem código e
documento. Os candidatos desse fallback não eram validados contra documentos completos ou códigos
divergentes. A persistência então sobrescrevia código/CNPJ e uma linha posterior podia sobrescrever
o mesmo cliente novamente. Isso tornava filiais da mesma empresa vulneráveis a deduplicação e merge
indevidos.

A regra permanente passa a aceitar código exato ou documento completo exato; nome+cidade+UF só é
fallback quando payload e candidato não possuem documento válido, o candidato não tem código
conflitante e o resultado é único. Documentos completos distintos são estabelecimentos distintos:
não atualizam nem participam de merge. A decisão gera `matchStrategy` estruturada sem expor o
documento completo. Ambiguidade sem documento permanece sem escrita automática destrutiva.

A regressão cobre os casos A–H, incluindo 5050×4484, documento exato com código diferente, fallback
sem documento, ambiguidade, duas filiais independentes e processamento posterior no mesmo sync.
Dados previamente afetados não são reparados automaticamente. A auditoria final comprovou que
`Client.code` pode ser reescrito pelo próprio `persistPartnerPayload()` para uma linha posterior e
pela edição administrativa `PUT /clients/:id`; importações só preenchem código vazio e merges geram
sufixos. Como o perfil financeiro 5050 só é gravado quando o cliente ainda tem `code=5050`, o estado
final exato 4484 prova uma escrita posterior ao financeiro. O full sync executa `partners` uma única
vez antes do financeiro, logo essa escrita final pertence necessariamente a outro partner sync ou a
um PUT posterior — não a uma etapa restante do mesmo full sync.

Após deploy, validar em homologação, monitorar estratégias/conflitos, confirmar IDs independentes e
reconciliar perfis financeiros sem rodar saneamentos. Detalhes, inventário completo de escritores,
diagramas, prova de ordem, limites de atribuição e procedimento completo estão na
[investigação de identidade 5050×4484](investigations/ultrafv3-partner-identity-5050-4484.md).

#### Pipeline, métricas e investigação read-only de parceiros

No pipeline vigente, `/partners` é convertido em `rows`; cada linha objeto passa por extração do
código ERP, normalização de documento, nome e localidade, busca de candidatos por código, documento
e identidade fraca, verificação de conflitos e persistência manual por `Client.update` ou
`Client.create`. Uma linha não é persistida quando não é objeto, não possui código em chave
reconhecida ou apresenta conflito forte entre código ERP e documento.

Em `ErpSyncRun`, `received` é a quantidade de elementos em `rows`;
`validAfterNormalization` é a quantidade que terminou com persistência bem-sucedida, não apenas a
quantidade normalizada; e `discardedAfterNormalization` é `received - syncedCount`, incluindo linha
não objeto, código ausente ou não reconhecido e conflito entre código e documento. `withoutCode`
conta linhas objeto sem código reconhecido, `discardedNonObject` conta elementos não objeto,
`ambiguousDuplicates` e `documentErpConflicts` são incrementados juntos no conflito forte e
`sellerChangedCount` conta updates concluídos nos quais `ownerSellerId` efetivamente mudou.

O serviço `erpPartnerInvestigationService.ts` e o comando
`npm run erp:investigate-partner -- --erp-code=<code>` consultam vendedores CRM ativos com suas
credenciais FV3 e não persistem parceiros. Devem ser executados no runtime da API, com Prisma Client
compatível e `DATABASE_URL`, `ULTRAFV3_BASE_URL` e `ERP_CREDENTIAL_ENCRYPTION_KEY` já fornecidas ao
processo e verificadas sem imprimir valores. A ferramenta consulta apenas a primeira resposta de
`/partners`, não informa a quantidade de linhas, devolve somente a primeira chave correspondente,
não extrai documento e não reproduz o matching completo de `persistPartnerPayload`. Assim,
`ERP_RETURNED=false` não prova ausência em páginas posteriores nem distingue chave desconhecida, e
`WOULD_CREATE`/`WOULD_UPDATE` são diagnósticos por `Client.code`, não decisões definitivas.

A sequência oficial é confirmar container, database, rede, volume e revisão; confirmar as variáveis
sem expô-las; executar a ferramenta read-only no runtime implantado; e correlacionar o resultado com
o `ErpSyncRun`. Se a imagem não contiver npm, tsx ou fontes, deve-se primeiro inspecionar sua
capacidade e então usar, se necessário, um container efêmero da mesma imagem, com a mesma rede,
variáveis e volumes somente leitura. Não se deve instalar dependências nem gerar Prisma Client no
container produtivo.

Fontes: [análise de causa raiz](investigations/erp-5050-root-cause-analysis.md),
[análise forense](investigations/erp-5050-forensic-analysis.md),
[fluxo completo](investigations/investigacao-erp-5050-fluxo-completo.md) e
[runbook forense](runbooks/erp-5050-forensic.md).

### Incidente de produção — julho de 2026

#### Linha do tempo consolidada

1. **Comprometimento do ambiente:** foram encontrados no volume atacado o banco
   `readme_to_recover` e a role superuser `priv_esc`. O ambiente deixou de ser uma fonte confiável e
   evidências, volumes e backups passaram a ser preservados.
2. **Revisão da estratégia de backups:** procedimentos destrutivos foram proibidos durante a
   recuperação; dumps passaram a ser validados, identificados por SHA256 e restaurados primeiro em
   ambientes isolados. Backups administrativos locais deixaram de depender das credenciais da
   aplicação e passaram a usar o usuário local `postgres` com autenticação peer.
3. **Criação dos ambientes de recuperação:** containers independentes foram criados para inspecionar
   cópias, testar dumps de datas diferentes, executar salvamento físico e ensaiar a composição final
   sem sobrescrever produção.
4. **Recuperação física:** o conteúdo recuperável do cluster/volume comprometido foi preservado e
   inspecionado em ambiente de salvamento isolado, mantendo a origem intacta para auditoria.
5. **Recuperação lógica:** dumps e dados reconciliados foram restaurados em bancos limpos; órfãos
   foram classificados antes de correções, 273 `ProductPrice` sem pai foram preservados em tabela de
   auditoria e removidos com guardrails, e seis FKs foram restauradas e validadas.
6. **Consolidação de produção:** depois dos ensaios e smokes, a API
   `gest-o-api-recovery-20260718` ficou configurada para o banco
   `gest-o-db-clean-v2-20260717` pela rede `gest-o_default`.

#### Inventário dos bancos de recuperação

| Container | Finalidade permanente registrada |
|---|---|
| `gest-o-db-clean-v2-20260717` | Banco limpo reconciliado e **atualmente configurado na produção**; é a referência operacional vigente. |
| `gest-o-db-final-recovery-test-20260719` | Ensaio isolado da recuperação lógica final de 19/07, usado para validar correções, integridade e procedimentos antes de produção. |
| `gest-o-db-physical-salvage-1022` | Salvamento físico isolado do cluster/volume comprometido, mantido para extração e conferência sem alterar a origem. |
| `gest-o-db-restore-test` | Ambiente temporário genérico para testar a restaurabilidade e a consistência de dumps. |
| `gest-o-db-june08-test` | Restauração isolada do backup de 08/06, usada para comparar o estado histórico e os limites daquele backup. |
| Demais bancos temporários | Cópias descartáveis ou preservadas para classificação, reconciliação, validação de dumps, FKs, smokes e rollback. Não são fontes de verdade nem destinos da API de produção. |

A existência de múltiplos PostgreSQL foi deliberada: cada hipótese ou etapa de recuperação precisava
de isolamento para impedir que testes, restaurações ou consultas sobre dados comprometidos
alterassem o banco escolhido para produção. O nome de um container, por si só, não indica que ele
esteja ativo ou autorizado para uso; antes de qualquer operação deve-se confirmar a ligação real da
API e preservar os ambientes que ainda sejam evidência do incidente.

## 12. Registro Permanente de Conhecimento

Somente fatos validados integram este registro:

1. O Gest-o é um monorepo com web, API e contratos compartilhados; PostgreSQL é a persistência
   relacional e integrações externas são mediadas pelo backend.
2. Produção exige preservação do volume oficial do PostgreSQL; reset destrutivo não é mecanismo de
   deploy ou recuperação. A referência operacional é o [README](../README.md) e os
   [runbooks de operação](ops/).
3. Dados reais de um ambiente e código no repositório são fontes distintas: saúde, versão implantada
   e integridade precisam ser confirmadas antes de qualquer diagnóstico conclusivo.
4. Sincronizações e criação de pedidos ERP exigem rastreabilidade, idempotência e validação; escrita
   direta no banco do ERP não é a estratégia recomendada. Consulte o
   [plano de integração](erp-products-order-integration-plan.md).
5. Agenda, eventos e atividades possuem sobreposição histórica; a direção aprovada é Activity-First,
   com migração compatível. Consulte o [blueprint](agenda-activity-first-architecture.md).
6. Segredos de produção devem permanecer fora do repositório e integrações não devem expor
   credenciais ao frontend. Consulte a [configuração de produção](erp-production-env-setup.md).
7. Evidências, logs e comandos pertencem às investigações e aos runbooks, não a este documento.
8. A arquitetura operacional nunca mais será reconstruída a partir do histórico de chat: containers,
   redes, conexões sanitizadas e papéis dos ambientes devem estar registrados em fonte permanente.
9. Toda descoberta operacional relevante deve ser incorporada ao Documento Mestre, consolidada na
   seção apropriada e sem depender de memória conversacional.
10. Todo incidente deve produzir documentação permanente antes do encerramento da investigação,
    incluindo topologia resultante, linha do tempo, ativos temporários que precisem ser preservados e
    lições aprendidas.

## 13. Riscos Estratégicos

| Risco | Impacto estratégico | Direção de tratamento |
|---|---|---|
| Escalabilidade | Crescimento de dados, canais e empresas pode exceder o desenho atual. | Medir antes de expandir e definir tenancy e limites por domínio. |
| Dependência tecnológica | ERP e provedores externos condicionam fluxos críticos. | Contratos isolados, tolerância a falhas e alternativas documentadas. |
| Infraestrutura | VPS, persistência e processo de deploy concentram continuidade. | Backups validados, recuperação exercitada, observabilidade e redução de pontos únicos. |
| Integrações | Duplicidade, divergência de identidade ou indisponibilidade corrompem o contexto comercial. | Idempotência, auditoria, reconciliação e fonte de verdade explícita. |
| Documentação | Dispersão ou desatualização induz decisões incorretas. | Documento Mestre como índice e documentação na DoD. |
| Continuidade | Dependência de pessoas e contexto conversacional reduz capacidade de retomada. | Conhecimento permanente, runbooks e revisão periódica de referências. |
| Segurança | Segredos, dados pessoais, webhooks e acessos administrativos ampliam exposição. | Menor privilégio, backend como fronteira, retenção e gates de produção. |
| Conhecimento | Hipóteses podem ser promovidas a fatos sem evidência suficiente. | Separar investigação de decisão e registrar somente conclusões validadas aqui. |

## 14. Glossário

| Termo | Definição |
|---|---|
| **ADR** | Registro do contexto, decisão arquitetural e suas consequências. |
| **Runbook** | Procedimento repetível para executar ou diagnosticar uma operação. |
| **Documento Mestre** | Referência executiva e técnica central que resume e conecta as fontes oficiais. |
| **Investigação** | Análise rastreável de uma questão ainda aberta ou de um incidente. |
| **Workflow** | Automação de integração, validação, preview ou publicação. |
| **Deploy** | Publicação controlada de uma versão em um ambiente. |
| **Smoke test** | Verificação rápida de capacidades essenciais após uma mudança. |
| **ERP 5050** | Identificador usado no contexto da investigação de clientes arquivados; não designa, por si só, uma causa. |
| **Prompt técnico** | Especificação orientada à execução de uma mudança, subordinada às decisões e fontes oficiais. |
| **Produção** | Ambiente que atende a operação real e contém dados que exigem proteção reforçada. |
| **Ambiente** | Instância isolada da aplicação e de suas configurações, como local, preview ou produção. |
| **DoD** | *Definition of Done*: critérios obrigatórios para considerar um trabalho concluído. |
| **Activity-First** | Direção arquitetural que trata a atividade como unidade central da agenda comercial. |
| **UltraFV3** | ERP externo integrado ao Gest-o para dados e fluxos operacionais selecionados. |

## 15. Sprint Atual

**Objetivo da sprint:** estabilizar e tornar verificável a operação atual antes de ampliar escopo.
Esta é uma sprint de consolidação; não autoriza novas integrações, automações destrutivas ou expansão
de canais. Itens só mudam de estado mediante evidência ligada à fonte especializada correspondente.

| Ordem | Entrega | Estado em 31/07/2026 | Critério de aceite |
|---:|---|---|---|
| S1 | Validar pós-deploy da identidade UltraFV3 e monitorar `matchStrategy`/conflitos. | Em andamento | Filiais independentes confirmadas, métricas revisadas e nenhuma escrita destrutiva sem explicação. |
| S2 | Concluir a investigação ERP 5050 com veredito revisável. | Em andamento | Evidência preservada e correlacionada com revisão, runtime e `ErpSyncRun`; hipótese não é promovida a fato. |
| S3 | Confirmar a topologia, revisão e saúde reais de produção. | Recorrente / pendente a cada deploy | Commit da aplicação, containers, rede, database, migrações e smokes registrados. |
| S4 | Exercitar backup/restauração e revisar hardening do VPS/PostgreSQL. | Pendente | Dump com hash restaurado em ambiente isolado, resultado documentado e acessos mínimos revisados. |
| S5 | Preparar a convergência Activity-First sem alterar contratos vigentes. | Planejamento | Inventário de contratos legados, plano de migração e testes de não regressão aprovados. |

**Fora do escopo desta sprint:** chat/RAG novo, outbound WhatsApp, Facebook, Instagram, automações
omnichannel, novos domínios ERP, tenancy, marketplace e aplicativos. Esses temas permanecem no
backlog e não devem ultrapassar os gates de estabilidade, segurança e governança.

## 16. Governança e Definition of Done

O Documento Mestre é a primeira fonte de contexto para pessoas e agentes de IA antes de novas
implementações, investigações, revisões arquiteturais ou mudanças estruturais. Ele organiza as
fontes oficiais sem transformar conteúdo transitório em conhecimento permanente.

### Princípios permanentes

1. Decisões relevantes não dependem da memória de pessoas, conversas ou ferramentas.
2. Cada assunto possui uma fonte oficial; este documento resume e referencia, sem duplicar.
3. Hipóteses e evidências permanecem nas investigações; procedimentos permanecem nos runbooks;
   contexto e consequências de decisões permanecem nos ADRs.
4. Documentação evolui antes ou junto com a mudança a que se refere.
5. Toda documentação permanente deve indicar atualização e, quando aplicável, responsável.

### Critério permanente de conclusão

Nenhuma funcionalidade, alteração arquitetural, melhoria estrutural ou investigação relevante é
considerada concluída enquanto:

- o Documento Mestre não refletir corretamente o novo estado do projeto; **ou**
- não existir documentação especializada atualizada e corretamente referenciada por ele.

Assim, documentação é parte oficial da **Definition of Done (DoD)** do Gest-o. Toda revisão e merge
com impacto relevante deve verificar explicitamente a atualização deste documento e das fontes
especializadas relacionadas.

## 17. Inventário do Trabalho Iniciado e Não Concluído

Este inventário precede qualquer proposta nova. **Iniciado** significa que já existe código,
contrato, tela, modelo, investigação ou fundação documentada; não significa que a capacidade esteja
pronta para produção. **Parcial** exige um próximo incremento explícito e não pode ser apresentado
como funcionalidade completa.

| Ordem recomendada | Capacidade iniciada | O que já existe | O que falta para conclusão | Status oficial |
|---:|---|---|---|---|
| 1 | Identidade e sincronização de parceiros UltraFV3 | Matching corrigido, estratégia registrada, auditoria de `Client.code`, runner read-only e métricas de execução. | Validar pós-deploy, reconciliar casos afetados sem saneamento cego, concluir causalidade do 5050 e avaliar unicidade futura. | **Em validação; não encerrado.** |
| 2 | Produção, deploy e recuperação | Stack recuperada, guardrails, dashboard de saúde, runbooks e backups defensivos. | Evidenciar revisão implantada, restauração periódica, hardening de VPS/PostgreSQL, observabilidade e descarte governado de ativos temporários. | **Operacional com pendências críticas.** |
| 3 | Agenda Activity-First | Agenda e atividades funcionais e blueprint aprovado. | Unificar contratos e migração, preservar compatibilidade e eliminar sobreposição legada com testes. | **Parcial / consolidação.** |
| 4 | Ciclo comercial UltraFV3 | Produtos, preços, oportunidades/itens, geração e sincronização selecionada de pedidos. | Completar protocolo de retorno, idempotência ponta a ponta, reconciliação, estados de erro e aceite produtivo por vendedor. | **Parcial / estabilização.** |
| 5 | Base de Conhecimento IA | Modelo e CRUD de documentos, busca, ativação/arquivamento, painel administrativo, contexto limitado para IA e documentos iniciais. | Governança editorial, autoria/versionamento, permissões por escopo, ingestão segura, avaliação de relevância e estratégia de RAG. | **MVP funcional; não consolidado.** |
| 6 | Categorias da IA | Taxonomia inicial (`produto`, `mix`, `cultura`, `argumento_comercial`, `objeção`, `manual_tecnico`, `treinamento`, `institucional`, `outro`) disponível no contrato e painel. | Donos, definição e exemplos por categoria, política de classificação, revisão de acentuação/compatibilidade, filtros de acesso e métricas de cobertura/qualidade. | **Implementadas tecnicamente; governança pendente.** |
| 7 | Inteligência assistida | Insights e fallbacks determinísticos, uso opcional de provider, contexto comercial e assistentes em pontos selecionados. | Contrato de provider consolidado, política de dados/prompts, avaliação, limites, telemetria, capacidade e decisão formal sobre Ollama/serviço externo. | **Distribuída e parcial.** |
| 8 | WhatsApp manual assistido | Geração de mensagem, abertura por URL e registro de atividade/timeline mediante ação humana. | Diferenciar claramente experiência manual da Inbox oficial; validar UX e métricas sem prometer entrega/mensagem recebida. | **Funcional, mas não é integração oficial.** |
| 9 | Infraestrutura Meta WhatsApp / omnichannel | Domínio genérico, modelos de conta/conversa/mensagem/evento, webhook inbound, challenge/HMAC, deduplicação, retenção e feature flags. | Migração e gate produtivo comprovados, secrets no VPS, configuração Meta, observabilidade, worker assíncrono, Inbox, revisão humana, mídia e outbound. | **Fundação inbound; produção não comprovada.** |
| 10 | Facebook e Instagram | Arquitetura provider-neutral permite expansão futura. | Provider, credenciais, webhooks, contratos canônicos, permissões, retenção, UX e homologação de cada canal. | **Não iniciados funcionalmente; somente preparados pela arquitetura.** |
| 11 | Financeiro | Contexto financeiro selecionado vindo do ERP. | Delimitar domínio, fonte de verdade, telas/fluxos, reconciliação e autorização. | **Parcial.** |
| 12 | Dashboard Saúde da Plataforma | Visão read-only, indicadores e fontes documentados. | Validar em produção, calibrar alertas/notificações e evoluir histórico sem duplicar fontes. | **Implementado; validação operacional pendente.** |
| 13 | Multiempresa / tenancy | Campos e cuidados preparatórios em comunicações e direção estratégica. | Registry de tenants, isolamento obrigatório, autorização, migração, configuração e testes de vazamento. | **Preparação arquitetural; não implementado como plataforma.** |

Compras, estoque, fretes, marketplace e aplicativos não entram no inventário de funcionalidades
iniciadas: permanecem planejados. A existência de menções, mocks ou direção arquitetural não deve
ser interpretada como entrega parcial.

## 18. Backlog Priorizado

O backlog usa **P0** para continuidade/segurança, **P1** para concluir valor já iniciado, **P2** para
expansão controlada e **P3** para exploração futura. Dentro da mesma prioridade, executar na ordem
listada. Novo item só pode preceder este backlog com decisão registrada e justificativa de risco.

| ID | Prioridade | Item | Dependência / saída esperada |
|---|---|---|---|
| B01 | P0 | Encerrar validação de identidade UltraFV3 e investigação 5050. | Evidência, veredito, monitoramento e plano de reconciliação aprovado. |
| B02 | P0 | Automatizar comprovação de versão/topologia pós-deploy. | Commit, imagem, serviços, database, rede e migrações correlacionados. |
| B03 | P0 | Exercitar restauração e executar hardening do VPS/PostgreSQL. | RTO/RPO observados, acesso mínimo, exposição de portas e retenção revisados. |
| B04 | P1 | Concluir convergência Activity-First. | Contratos unificados e migração sem regressão. |
| B05 | P1 | Fechar ciclo de pedidos UltraFV3. | Idempotência, retorno, reconciliação, falhas e aceite produtivo. |
| B06 | P1 | Governar Base de Conhecimento e categorias da IA. | Curadoria, permissões, versionamento, qualidade e critérios de publicação. |
| B07 | P1 | Consolidar a plataforma de IA e seus fallbacks. | Provider/infra decididos, política de dados, testes de qualidade e métricas. |
| B08 | P1 | Homologar fundação inbound Meta WhatsApp. | Migration gate, secrets, webhook, retenção, alertas e rollback comprovados. |
| B09 | P2 | Entregar Inbox WhatsApp com revisão humana. | Tenant-aware, busca segura, vínculo/desvínculo auditado e operação suportada. |
| B10 | P2 | Adicionar outbound WhatsApp controlado. | Consentimento/template, idempotência, rate limit, status e auditoria; nunca no ACK do webhook. |
| B11 | P2 | Avaliar Facebook e Instagram separadamente. | Caso de uso e compliance aprovados antes de implementar providers. |
| B12 | P2 | Completar financeiro e desenhar compras/estoque/fretes. | ADR e fonte de verdade por domínio. |
| B13 | P3 | Arquitetura multiempresa. | Tenancy e isolamento comprovados antes de marketplace. |
| B14 | P3 | Marketplace, aplicativos e ecossistema. | Business case e fundações anteriores concluídas. |

## 19. Incidentes Resolvidos

“Resolvido” descreve a contenção/restauração comprovada; não elimina ações preventivas nem converte
investigações relacionadas em concluídas.

| Incidente | Resultado consolidado | Pendência preventiva |
|---|---|---|
| Comprometimento e recuperação de produção — julho/2026 | Origem comprometida isolada; dados recuperados e reconciliados; 273 órfãos preservados em auditoria e removidos com guardrails; seis FKs restauradas; produção apontada para o banco limpo. | Hardening, teste periódico de restauração, gestão dos ativos forenses e monitoramento contínuo. |
| Integridade referencial após recuperação | Checks e smokes confirmaram a composição recuperada descrita no runbook final. | Reexecutar checks após migrações e mudanças de persistência. |

O histórico detalhado permanece em [`incidents/`](incidents/) e [`investigations/`](investigations/).
Um incidente não deve ser reaberto apenas para registrar melhoria futura; reabrir quando o sintoma,
impacto ou causa não estiver de fato contido.

O merge indevido de filiais UltraFV3 5050×4484 **não integra ainda esta lista de encerrados**: embora
a causa no fallback fraco, a correção, as regressões A–H e a auditoria de escritores estejam
documentadas, faltam validação do deploy, reconciliação segura dos dados afetados e observação. A
investigação histórica 5050 mais ampla também permanece aberta.

## 20. Procedimentos Pós-Deploy

Todo deploy, inclusive documentalmente “sem mudança funcional”, deve deixar evidência mínima. Para
mudanças de schema, ERP, identidade, autenticação, comunicação ou infraestrutura, os itens marcados
**VPS obrigatório** exigem execução no servidor; merge/CI não os substituem.

### 20.1 Antes de promover

1. Registrar commit/tag candidato, escopo, migrations e plano de rollback.
2. Confirmar backup recente e, para mudança de dados/schema, criar dump protegido com SHA256.
3. Verificar flags e segredos necessários sem imprimir valores; manter capacidades novas desligadas
   por padrão até o gate específico.
4. Executar testes automatizados e checklist manual do fluxo afetado.

### 20.2 Ações obrigatórias no VPS

1. **VPS obrigatório — identificar o alvo:** registrar hostname, containers ativos, imagens/commit,
   rede, volumes e banco efetivamente referenciado pela `DATABASE_URL` sanitizada da API.
2. **VPS obrigatório — proteger os dados:** confirmar volume oficial e backup; nunca usar reset,
   remoção de volume ou database alternativo como mecanismo de deploy.
3. **VPS obrigatório — atualizar com o fluxo oficial:** executar o procedimento de
   [deploy de produção](deploy-production.md), preservando `.env`/segredos e observando o resultado
   de pull/build/up/migrations. Não editar código dentro do container.
4. **VPS obrigatório — conferir banco e migrations:** verificar que a API aponta para
   `salesforce_pro` no destino autorizado e que migrations esperadas foram aplicadas exatamente uma
   vez. Migração de comunicações deve preceder habilitação de seus flags.
5. **VPS obrigatório — saúde técnica:** verificar estado/restarts de web, API, PostgreSQL e proxy;
   ler logs recentes sanitizados; validar healthcheck e ausência de loop/erro de conexão.
6. **VPS obrigatório — smoke funcional:** autenticação, dashboard, cliente, agenda/atividade,
   oportunidade e leitura ERP. Se o escopo tocar pedidos, executar o smoke de prontidão sem gerar
   duplicidade. Registrar horário, operador e resultado.
7. **VPS obrigatório — revisão implantada:** comprovar que assets/frontend e runtime/API
   correspondem ao commit promovido; limpar apenas caches permitidos, nunca dados persistentes.
8. **VPS obrigatório — segurança de rede:** confirmar que PostgreSQL e portas administrativas não
   ficaram publicamente expostos e que somente portas/proxies aprovados estão acessíveis.
9. **VPS obrigatório — observação:** acompanhar erros, latência, CPU, RAM, disco, reinícios e métricas
   ERP durante a janela definida; anexar evidência ao deploy/incidente.

### 20.3 Gates específicos

- **Identidade/ERP:** monitorar contagem por `matchStrategy`, ambiguidades e conflitos; confirmar IDs
  independentes das filiais; não executar merge ou saneamento automático no pós-deploy.
- **Meta WhatsApp:** iniciar com `COMMUNICATIONS_ENABLED=false` e
  `WHATSAPP_INTEGRATION_ENABLED=false`; confirmar migration, secrets, challenge, assinatura HMAC,
  deduplicação, retenção e status antes de habilitar. Validar inbound controlado e então observar;
  rollback é desligar flags, nunca apagar tabelas.
- **IA/Base de Conhecimento:** confirmar provider, limites e permissões; testar fallback com IA
  desligada; não enviar segredos, documentos fora do escopo ou payload integral do ERP.
- **Falha em qualquer gate:** interromper promoção, preservar logs/evidências e executar rollback
  documentado. Não improvisar restauração sobre o banco oficial.

## 21. Critérios de Encerramento de Incidentes

Um incidente só recebe estado **encerrado** quando todos os critérios aplicáveis estiverem atendidos:

- impacto contido e serviço/dados em estado estável durante janela definida pelo responsável;
- causa raiz comprovada, ou causa declarada inconclusiva com limites de evidência e risco residual
  explicitamente aceitos — “não reproduziu” não é causa raiz;
- topologia, versão, timeline, escopo de dados e ativos afetados registrados;
- correção/recuperação validada por testes, smokes e monitoramento, sem regressão crítica conhecida;
- integridade e reconciliação de dados verificadas; qualquer reparo pendente tem dono e plano;
- backup pós-recuperação criado, hash registrado e restauração testada quando o incidente envolveu
  persistência, corrupção, perda ou segurança;
- segredos rotacionados, acessos revistos e hardening concluído quando houver comprometimento;
- rollback e runbook de recorrência executáveis; alertas/indicadores capazes de detectar repetição;
- evidências sanitizadas preservadas com localização e política de retenção; ativos temporários têm
  decisão explícita de preservar, arquivar ou descartar;
- comunicação de encerramento registra impacto, resolução, risco residual, responsáveis e data;
- Documento Mestre, incidente, investigação, ADR e runbooks relacionados estão coerentes.

Se faltar evidência essencial, o estado correto é **mitigado/em observação** ou **investigação
inconclusiva**, nunca “resolvido” por conveniência. Ações preventivas não bloqueiam encerramento
quando são melhoria de longo prazo, mas devem estar no backlog com prioridade, dono e risco aceito.

## 22. Evoluções Futuras

Estas evoluções não sobrepõem o inventário iniciado nem o backlog prioritário:

1. **IA governada e RAG:** busca semântica, chunking, citações internas, avaliação de respostas,
   versionamento e acesso por tenant/perfil, somente após curadoria da Base de Conhecimento.
2. **Omnichannel completo:** Inbox humana, outbound consentido, templates, mídia e automações
   assíncronas; Facebook/Instagram entram como providers independentes e não como extensão tácita do
   WhatsApp.
3. **ERP comercial ampliado:** financeiro, compras, estoque e fretes com contratos, fontes de verdade
   e reconciliação por domínio.
4. **Observabilidade e resiliência:** métricas históricas, alertas acionáveis, filas/workers, cache
   compartilhado quando necessário, recuperação exercitada e redução do ponto único no VPS.
5. **SaaS multiempresa:** tenant registry, isolamento obrigatório, políticas de autorização,
   configuração, auditoria, billing e migração segura do legado.
6. **Marketplace e aplicativos:** jornadas validadas de oferta/demanda e mobilidade após a fundação
   multiempresa, sem duplicar regras críticas fora da API.

Toda evolução futura começa com hipótese de valor, dependências, riscos, fonte de verdade, métricas
de sucesso e ADR quando alterar arquitetura. Mock, campo preparatório ou documento de intenção não
autoriza divulgar uma capacidade como implementada.

## 23. Regra de Atualização deste Guia

Ao iniciar uma capacidade, atualizar o inventário e o backlog. Ao entrar em execução, atualizar a
Sprint Atual. Ao implantar, registrar os gates pós-deploy. Ao encerrar incidente, aplicar integralmente
os critérios de encerramento. Ao concluir uma capacidade, mover seu status para funcional somente
com evidência e retirar do inventário de pendências sem apagar seu histórico documental.

## Apêndice — Saúde da Plataforma (31/07/2026)

O Gest-o passa a oferecer um dashboard técnico e executivo, somente leitura, complementar ao Dashboard Comercial. A arquitetura, indicadores, fontes, cache, permissões, notificações e plano de evolução estão documentados em [Dashboard Saúde da Plataforma](dashboard-saude-plataforma.md). A implementação reutiliza os contadores das execuções ERP e a tabela `ClientCodeAudit`, sem modificar matching ou sincronizações.
