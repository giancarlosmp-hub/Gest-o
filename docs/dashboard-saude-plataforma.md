# Dashboard Saúde da Plataforma

## Objetivo e arquitetura

O módulo é o painel executivo complementar ao Dashboard Comercial. Ele é somente leitura: não altera sincronizações, regras de negócio ou `resolvePartnerIdentityMatch()`. A interface React organiza cinco visões (Visão geral, Qualidade dos dados, Integrações, Auditoria e Alertas), consumindo a API autenticada `/api/platform-health`. O serviço agrega `ErpSyncRun`, `Client`, `ClientCodeAudit` e, principalmente, os contadores já gravados em `ErpSyncRun.metrics` pela sincronização.

A API possui cache em memória de 60 segundos, limite de 100 execuções por janela, histórico visual limitado a 20 itens e auditoria paginada (25 por página, máximo 100). Exportações CSV são limitadas a 5.000 linhas. Assim, a tela nunca carrega toda a base e não recalcula a decisão de identidade.

## Indicadores e origem dos dados

| Área | Indicadores | Origem | Atualização |
|---|---|---|---|
| Visão geral | última execução, status, duração, média, parceiros/clientes/pedidos, erros, alterações de código e estratégias de identidade | `ErpSyncRun`, `ErpSyncRun.metrics`, `ClientCodeAudit` | cache de 60 s / atualização manual |
| Qualidade | documento ausente/inválido/duplicado, vendedor, região, carteira, município, UF, contatos, financeiro, títulos e arquivados | agregações de `Client` | cache de 60 s |
| Integrações | conexão inferida, comunicação, latência, média, sucesso, erro, retries e histórico | últimas 100 linhas de `ErpSyncRun` | cache de 60 s |
| Auditoria | antes/depois, origem, ator, Partner ERP, IP e requestId | `ClientCodeAudit` | consulta paginada sob demanda |
| Alertas | conflito, alterações excessivas, sync parada/lenta, duplicidade e inconsistências | snapshot agregado | a cada snapshot |
| Tendências | duração e alteração de `Client.code`, com seletores de 7/30/90 dias | execuções e auditoria do período | cache de 60 s |

Telefone/e-mail são apurados por existência de contatos vinculados; inconsistências financeiras usam agregação sobre o tipo JSON persistido, sem transportar payloads para a aplicação. Em escala maior, esses cálculos devem migrar para rollups materializados.

## Layout

O cabeçalho verde segue o padrão visual executivo do Dashboard Comercial. Cada cartão contém ícone, semáforo, valor, horário e navegação. As abas preservam contexto; tabelas são responsivas; a auditoria oferece busca, paginação e CSV. Os gráficos alternam 7, 30 e 90 dias.

## Permissões e notificações

A API aceita Diretor, Administrador/Admin, Suporte e TI e rejeita vendedores. Como o enum de usuários instalado hoje contém apenas Diretor, Gerente e Vendedor, a navegação inicial fica visível ao Diretor; os demais nomes já são aceitos pela política da API quando forem introduzidos pelo futuro controle granular. A abstração `PlatformHealthNotificationProvider` contempla Slack, Teams, e-mail e webhook, mas nenhum adaptador externo é registrado nesta entrega.

## Impacto de performance

As consultas são `count`, `groupBy`, agregações SQL indexáveis, leitura limitada de runs e auditoria paginada. O cache reduz rajadas de acesso executivo. Para bases maiores, o plano é: índices parciais de qualidade, tabela diária de métricas, cache distribuído, jobs de rollup e exportação assíncrona.

## Plano de evolução

1. Formalizar perfis Administrador, Suporte e TI e permissões granulares.
2. Criar rollups diários de todas as séries de tendência e qualidade de JSON.
3. Registrar latência de transporte, warnings e retries como campos estruturados.
4. Implementar adapters opt-in, coalescência e escalonamento das notificações.
5. Adicionar SLOs configuráveis, reconhecimento de alertas e correlação de incidentes.
6. Evoluir exportações grandes para jobs com arquivo temporário auditado.
