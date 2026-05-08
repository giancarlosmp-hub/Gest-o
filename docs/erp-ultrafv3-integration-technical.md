# Integração ERP UltraFV3 — arquitetura técnica

## Escopo desta etapa

O CRM continua responsável apenas pela organização comercial. O ERP Gestão/FV3 permanece como fonte oficial fiscal, estoque, financeiro e operação.

Fluxo suportado:

1. oportunidade no CRM avança até **Ganha**;
2. usuário abre **Gerar pedido ERP**;
3. CRM valida vínculos ERP de cliente, vendedor e operador;
4. CRM monta payload UltraFV3 com `PEDIDO_ID_IMPORTACAO`, `NUM_PEDIDO`, `OPERADOR`, datas `DD.MM.YYYY` e itens;
5. backend envia para `/orders` com autenticação UltraFV3;
6. retorno e payload são persistidos em `ErpOrderSync`;
7. status operacional é atualizado via `/orderStatus`.

## Configuração obrigatória

O backend exige as variáveis:

- `ULTRAFV3_BASE_URL`
- `ULTRAFV3_USERNAME`
- `ULTRAFV3_PASSWORD`

O client UltraFV3 centralizado valida essas variáveis antes de qualquer chamada, autentica em `/auth/login`, mantém token em memória, guarda expiração quando retornada pela API, renova em token expirado/401 e faz **um único retry** após 401.

## Services principais

- `ultraFv3Client`: cliente HTTP desacoplado, com timeout de 15s, tratamento padrão de erros, diagnóstico de autenticação e retry único em 401.
- `ultraFv3SyncService`: sincroniza dados mestres do ERP para o CRM:
  - produtos;
  - estoque;
  - unidade;
  - marca;
  - grupo;
  - tabela de preço em `ProductPrice`;
  - clientes/parceiros, cidade, CNPJ, código ERP e vendedor vinculado.
- `erpOrderService`: concentra regra do fluxo oportunidade ganha → pedido ERP, incluindo resolução de `NUM_PEDIDO` a partir de `/salesmen`, `OPERADOR` do usuário CRM e persistência de envio/status.

## Persistência

A tabela `ErpOrderSync` registra:

- oportunidade e vendedor CRM;
- `PEDIDO_ID_IMPORTACAO` UUID v4;
- `NUM_PEDIDO`;
- número de pedido retornado pelo ERP;
- status de sincronização (`pending`, `sent`, `error`);
- status operacional ERP (`pendente`, `faturado`, `parcial`, `cancelado`, `entregue`);
- payload enviado;
- resposta ERP;
- erros;
- último payload de `/orderStatus`.

## Rotas backend

- `POST /opportunities/:id/erp/orders`: gera pedido ERP real para oportunidade **Ganha**.
- `GET /opportunities/:id/erp/orders`: lista histórico de pedidos ERP da oportunidade.
- `POST /opportunities/:id/erp/orders/status`: consulta `/orderStatus` para pedidos da oportunidade.
- `POST /erp/ultrafv3/sync/order-status`: sincronização administrativa de status de todos os pedidos enviados.
- Rotas já existentes de sync continuam disponíveis para produtos, clientes/parceiros, vendedores, tabelas e parâmetros comerciais.

## Regras de segurança operacional

- O CRM bloqueia pedido para oportunidade que não esteja em `ganho`.
- O CRM bloqueia pedido sem código ERP do cliente.
- O CRM bloqueia pedido sem `CODVENDEDOR` ou `OPERADOR` ERP no usuário CRM.
- O CRM bloqueia pedido sem itens, sem código de produto ERP ou sem unidade.
- O CRM não calcula lógica fiscal completa; envia os dados comerciais necessários e preserva o ERP como fonte oficial.
