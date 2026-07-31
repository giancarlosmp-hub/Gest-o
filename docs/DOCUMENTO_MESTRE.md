# Gest-o — Documento Mestre

- **Versão:** 2.3
- **Última atualização:** 30 de julho de 2026
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
6. [Roadmap Geral](#6-roadmap-geral)
7. [Arquitetura](#7-arquitetura)
8. [Estado dos Módulos](#8-estado-dos-módulos)
9. [ADRs](#9-adrs)
10. [Runbooks](#10-runbooks)
11. [Investigações Técnicas](#11-investigações-técnicas)
12. [Registro Permanente de Conhecimento](#12-registro-permanente-de-conhecimento)
13. [Riscos Estratégicos](#13-riscos-estratégicos)
14. [Glossário](#14-glossário)
15. [Próximos Passos](#15-próximos-passos)
16. [Governança e Definition of Done](#16-governança-e-definition-of-done)

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

## 6. Roadmap Geral

O roadmap é organizado por capacidades; suas situações são uma fotografia estratégica, não um
cronograma. Planejamentos detalhados devem ser mantidos em [`roadmap/`](roadmap/README.md).

| Fase | Objetivo | Situação atual | Próximos passos |
|---|---|---|---|
| 1. CRM interno confiável | Centralizar operação, carteira, agenda e pipeline. | Em consolidação, com núcleo funcional. | Fechar riscos críticos, uniformizar atividade/agenda e fortalecer validação operacional. |
| 2. CRM comercial integrado | Conectar catálogo, oportunidades, pedidos e canais. | Parcial: catálogo, itens, ERP e fundação omnichannel já existem. | Estabilizar sincronizações, governar canais e completar o ciclo comercial. |
| 3. ERP comercial | Incorporar visão operacional de financeiro, compras, estoque e fretes. | Planejado; não há cobertura completa desses domínios. | Definir limites, fontes de verdade e contratos por domínio antes da implementação. |
| 4. Plataforma multiempresa | Isolar organizações, dados, configuração e governança. | Direção estratégica. | Elaborar arquitetura de tenancy, identidade, segurança e migração. |
| 5. Marketplace e aplicativos | Conectar oferta, demanda e jornadas móveis. | Visão futura. | Validar casos de negócio e dependências da plataforma multiempresa. |
| 6. Ecossistema completo | Integrar empresas, parceiros, automação e inteligência. | Visão de longo prazo. | Evoluir somente sobre fundações operacionais e de governança comprovadas. |

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

## 15. Próximos Passos

1. Encerrar, com evidência autorizada, a investigação crítica do ERP 5050 e incorporar apenas sua
   conclusão permanente às referências oficiais.
2. Consolidar o CRM interno e a arquitetura Activity-First, reduzindo contratos sobrepostos sem
   romper os fluxos existentes.
3. Estabilizar o ciclo comercial integrado ao UltraFV3, com identidade, idempotência, auditoria e
   reconciliação explícitas.
4. Elevar previsibilidade de produção por meio de versionamento verificável, observabilidade,
   backup e recuperação exercitados.
5. Evoluir omnichannel e IA somente após seus gates de segurança, capacidade e governança.
6. Definir as fundações de domínios ERP e multiempresa antes de ampliar o escopo do ecossistema.
7. Organizar progressivamente decisões novas em `docs/adr`, mantendo este documento como índice vivo.

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

## Saúde da Plataforma (31/07/2026)

O Gest-o passa a oferecer um dashboard técnico e executivo, somente leitura, complementar ao Dashboard Comercial. A arquitetura, indicadores, fontes, cache, permissões, notificações e plano de evolução estão documentados em [Dashboard Saúde da Plataforma](dashboard-saude-plataforma.md). A implementação reutiliza os contadores das execuções ERP e a tabela `ClientCodeAudit`, sem modificar matching ou sincronizações.
