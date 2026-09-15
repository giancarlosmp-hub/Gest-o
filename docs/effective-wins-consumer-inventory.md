# Inventário — ganhos efetivos e cancelamento ERP (2026-09-14)

## Regra consolidada
A etapa `ganho` continua sendo o registro histórico comercial. A projeção `effectiveWin` é calculada, sem escrita ou decremento: único pedido efetivo `CANCELADO` => quantidade e valor zero; pedidos válidos sem cancelamento => quantidade e valor comerciais anteriores; pedidos múltiplos com cancelamento => os pedidos remanescentes contribuem por seus valores ERP explícitos, sem rateio do valor da oportunidade; valor remanescente ausente preserva o valor anterior com inconsistência explícita. Substituição exige `supersedesErpOrderSyncId`; nunca se deduplica por cliente, valor ou data.

## Consumidores alterados
| Consumidor | Uso | Aplicação |
|---|---|---|
| Dashboard `/summary` | quantidade/valor, conversão, realizado, ranking | projeção compartilhada |
| Dashboard `/sales-series` | realizado diário/acumulado | projeção compartilhada, sem mudar período/meta |
| Dashboard `/portfolio` | última venda, curva ABC, vendido hoje | exclui ganho integralmente cancelado e usa valor efetivo |
| Oportunidades lista/pipeline/detalhe | apresentação e totais de encerradas | retorna `effectiveWin`; etapa histórica permanece `ganho` e recebe aviso explícito |
| Relatório de encerradas | total, contagem, ticket, conversão | usa `/opportunities/summary`, a mesma projeção |
| Exportação CSV de encerradas | valor e classificação | usa a mesma API; exporta etapa histórica, valor efetivo e observação ERP |
| Relatórios score mensal, destaques, score comercial e consistência | valor realizado | agregado compartilhado com os mesmos filtros anteriores |

## Consumidores que não mudam
- Pipeline aberto, probabilidades e valores ponderados de etapas abertas: não são ganhos efetivos e devem preservar a fórmula existente.
- Metas: denominadores/valores-alvo não mudam; somente o realizado efetivo muda.
- Timeline e histórico de mudanças de etapa: são eventos históricos; continuam acessíveis e distinguem o ganho ocorrido do cancelamento ERP posterior.
- Resumo textual do cliente e inteligência comercial: descrevem relacionamento/histórico, não total financeiro efetivo.
- Disciplina, visitas, atividades, agenda e execução: não derivam de valor ganho.
- Geração de PDF do pedido: representa o pedido, não uma métrica de ganho.

## Sincronização e ordenação
Todos os caminhos convergem em `syncErpOrderStatuses`: consulta individual em Pedidos, consulta pela oportunidade, endpoint administrativo, etapa da sincronização completa e scheduler. O cálculo não usa cache persistente; cada leitura de métrica parte do estado consolidado. Atualizações concorrentes usam o instante de início como guarda otimista, impedindo uma execução iniciada antes de sobrescrever uma iniciada depois. O contrato não fornece timestamp confiável do evento ERP; portanto a ordenação entre snapshots externos anteriores ao início da consulta não pode ser provada.

`GET /orders` (“Recarregar lista”) só lê o CRM. A reconciliação existente é a consulta individual ou a sincronização `orderStatus` já operada pelo scheduler/sincronização completa; nenhuma automação nova foi criada.

## Exemplos numéricos de múltiplos pedidos
- Oportunidade de **R$ 300**, pedido cancelado de R$ 100 e pedido finalizado de R$ 200: ganho efetivo **R$ 200**, quantidade **1**. Não há rateio; R$ 200 é o valor explícito do pedido válido.
- Oportunidade de **R$ 500**, pedido cancelado de R$ 100 e pedido finalizado de R$ 200: ganho efetivo **R$ 200**, quantidade **1**, com aviso de que R$ 500 diverge da soma dos pedidos (R$ 300). Os R$ 200 são confirmados pelo pedido válido; os R$ 200 sem atribuição não são estimados.
- Oportunidade de **R$ 500**, pedido cancelado de R$ 100 e pedido finalizado sem `VALOR_LIQUIDO`: preserva provisoriamente **R$ 500**, quantidade **1**, com valor efetivo não confirmado. O sistema não inventa rateio.
- Oportunidade de **R$ 450** com único pedido `PARCIAL`: preserva **R$ 450** e quantidade **1**, pois atendimento parcial não comprova cancelamento.
- Oportunidade de **R$ 369,86** com único pedido integralmente `CANCELADO`: ganho efetivo **R$ 0** e quantidade **0**.
