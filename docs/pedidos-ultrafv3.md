# Módulo Pedidos integrado ao UltraFV3

## Propósito

Pedidos é uma visão operacional/comercial, não um novo processo de venda. Todo item exibido nasce de `ErpOrderSync`, criado pelo fluxo existente da oportunidade ganha.

## Fontes dos campos

| Campo Gest-o | Fonte comprovada |
|---|---|
| número interno | `ErpOrderSync.numPedido` / `NUM_PEDIDO` enviado |
| ID ERP | `PEDIDO_ID` da resposta de `POST /orders` |
| número ERP | `NUM_PEDIDO` da resposta, com o número enviado como fallback |
| cliente/oportunidade/vendedor | relações CRM do `ErpOrderSync` |
| valor, filial e previsão | payload persistido do `POST /orders` |
| quantidades operacionais | resposta persistida, quando presente |
| situação | `SITUACAO_PEDIDO`, preservada e normalizada para estado interno conhecido |
| NFe | não instrumentada: falta rota e chave de associação comprovadas |

## Identidade, idempotência e estados

`pedidoIdImportacao` possui unicidade no banco. O fluxo também usa advisory lock por oportunidade e impede novo envio diante de sucesso ou resultado incerto. `Opportunity.stage`, `ErpOrderSync.status` e `orderStatus`/`operationalStatusRaw` são dimensões diferentes. O histórico append-only registra criação, resposta, reconciliação e falha, com origem/data e erro limitado/sanitizado. Cancelamento operacional não altera o ganho histórico.

Estados contratuais: DIGITADO, ACEITO, PARCIAL, FINALIZADO e CANCELADO. EXPEDINDO, FATURAR e SUSPENSO são somente estados vistos na UI externa; podem aparecer como texto, sem regra de negócio presumida. A legenda oficial desktop “Legenda Solicitações” é uma dimensão independente: branco = nenhuma solicitação/restrição; amarelo = solicitações parcialmente autorizadas; vermelho = nenhuma solicitação autorizada; verde = todas autorizadas. Ela não representa situação operacional, sincronização, oportunidade, risco, faturamento ou expedição. A regra cromática do aplicativo móvel permanece não comprovada e não é equiparada à legenda desktop. A interface sempre acompanha cor com texto e explicação acessível.

## Segurança e agregação

A API resolve uma única associação ativa do usuário. Toda leitura atravessa cliente/tenant; vendedor recebe apenas pedidos próprios. Agregações são feitas uma vez por pedido depois da projeção, sem `JOIN` multiplicador por item. Payload integral, credenciais e PII não são retornados.

## Observabilidade, implantação e rollback

Executar geração Prisma, typecheck, build e testes de oportunidade/UltraFV3/tenant antes da implantação. A migration é aditiva e realiza backfill do tenant via oportunidade/cliente. Em rollback, desabilitar rota/menu mantendo os dados e histórico; não fazer rollback destrutivo. Nenhum acesso a produção faz parte desta entrega.


## Nota fiscal — lacuna contratual

A NF é visualmente observável na lista móvel em ao menos um pedido finalizado, mas não aparece como campo comprovado no `POST /orders` nem no `GET /orderStatus`. Não se conhece a rota de origem, chave com `PEDIDO_ID`, cardinalidade zero/uma/várias, regra de faturamento parcial ou tratamento de notas canceladas. A arquitetura da resposta usa um envelope extensível, mas não cria persistência nem infere NF por `FINALIZADO` ou `QTD_FATURADO`; exibe “NF-e não instrumentada”.
