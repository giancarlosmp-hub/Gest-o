# Fluxo operacional ERP UltraFV3

Este fluxo deve ser usado na produção controlada para validar o primeiro uso real da integração ERP, com foco em operação, monitoramento, diagnóstico e estabilidade.

## 1. CRM → oportunidade

1. Cadastre ou sincronize clientes pelo fluxo de parceiros UltraFV3.
2. Confirme que o cliente possui `code`/código ERP no CRM.
3. Confirme que o vendedor responsável possui vínculo ERP:
   - `erpCode` / CODVENDEDOR;
   - `erpOperatorCode` / OPERADOR.
4. Avance a oportunidade até a etapa **Ganha** somente quando o pedido estiver pronto para emissão.
5. Inclua itens com produto ERP, unidade, quantidade, preço e totais válidos.

## 2. Pré-validação operacional

Antes de gerar pedido real, valide no painel de integração ERP:

- status UltraFV3;
- último login;
- expiração do token;
- último sync de produtos;
- último sync de clientes/parceiros;
- pedidos pendentes;
- pedidos com erro.

Use a opção **Simulação ERP** na oportunidade para validar o payload sem enviar pedido real ao UltraFV3.

## 3. Bloqueios antes de enviar pedido ERP

O backend impede geração do pedido ERP quando ocorrer qualquer uma das situações abaixo:

- cliente sem código ERP;
- vendedor sem CODVENDEDOR ERP;
- vendedor sem OPERADOR ERP;
- oportunidade fora da etapa Ganha;
- oportunidade sem itens;
- item sem código ERP;
- item sem unidade;
- item com preço/total zerado;
- estoque insuficiente quando o estoque estiver disponível no cadastro de produto;
- tabela de preço inválida, quando há catálogo sincronizado;
- operação inválida, quando há catálogo sincronizado.

## 4. Oportunidade → pedido ERP

1. Abra a oportunidade Ganha.
2. Clique em **Gerar pedido ERP**.
3. Revise cliente, vendedor, operador e itens.
4. Selecione forma de pagamento, condição de recebimento, tabela de preço, filial e operação.
5. Primeiro marque **Simulação ERP** e valide o payload.
6. Desmarque **Simulação ERP** e envie o pedido real somente após validação.

Cada operação ERP recebe um `correlationId` para rastreamento em logs.

## 5. Pedido ERP → orderStatus

Após envio real:

1. O pedido fica registrado em `ErpOrderSync`.
2. Use **Atualizar status** na oportunidade ou o sync administrativo global de `order-status`.
3. O backend consulta `/orderStatus` usando o pedido ERP, `numPedido` ou `pedidoIdImportacao`.
4. O status é normalizado para:
   - `pendente`;
   - `faturado`;
   - `parcial`;
   - `cancelado`;
   - `entregue`.

## 6. Diagnóstico administrativo

Endpoint administrativo:

```http
GET /erp/ultrafv3/diagnostics
```

Retorna status UltraFV3, último login, token expirado, últimos syncs de produtos/clientes e contadores de pedidos pendentes/com erro.

## 7. Logs operacionais

Os logs foram padronizados para facilitar suporte em produção controlada:

- `[ultrafv3 sync products]` para sync de produtos;
- `[ultrafv3 sync partners]` para sync de clientes/parceiros;
- `[erp order]` para criação/envio de pedido;
- `[erp order simulation]` para simulação;
- `[erp order status]` para `/orderStatus`;
- `[ultrafv3 auth]` para autenticação;
- `[ultrafv3 timeout]` para timeout;
- `[erp order route] invalid payload` para payload inválido.

Em incidentes, procure primeiro pelo `correlationId`, depois por `pedidoIdImportacao` e `erpOrderSyncId`.
