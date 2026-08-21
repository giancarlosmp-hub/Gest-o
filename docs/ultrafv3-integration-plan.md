# Integração CRM → UltraFV3 (ERP)

## Objetivo
Integrar o CRM ao ERP **somente** pela API UltraFV3 (`:8585`), sem acesso direto ao Firebird.

## Contrato de integração
- Base URL por ambiente: `ULTRAFV3_BASE_URL=http://<ip-servidor-windows>:8585`
- Autenticação: `POST /auth/login` com `username/password` e uso de Bearer JWT
- Catálogos de referência antes do envio:
  - `GET /salesmen`
  - `GET /partners`
  - `GET /products`
  - `GET /priceTables`
  - `GET /paymentMethods`
  - `GET /receivingConditions`
  - `GET /branches`
  - `GET /operations`
- Envio de pedido: `POST /orders`
- Consulta de status: `GET /orderStatus`

## Regras obrigatórias
1. O CRM deve gerar UUID v4 e preencher `PEDIDO_ID_IMPORTACAO` em todos os envios.
2. Datas no formato `DD.MM.YYYY`.
3. Em `401`, renovar token e repetir o request uma única vez.
4. Idempotência no CRM por `PEDIDO_ID_IMPORTACAO` para evitar duplicidade.
5. Persistência local do envio no CRM:
   - `status = enviado | erro`
   - `pedido_id_importacao`
   - `payload_enviado`
   - `resposta_ultrafv3`

## Mapeamentos mínimos
- `OPERADOR`: usuário logado no CRM mapeado para operador do ERP.
- `VENDEDOR`, `PARCEIRO`, `CODCONDREC`, `FORMA`, `CODFILIAL`, `CODOPER`, `TABELA_PRECO`:
  sempre resolvidos pelos endpoints de referência UltraFV3.

## Payload de pedido
O payload deve seguir o mesmo formato já aceito em produção pelo UltraFV3,
inclusive campos nulos/defaults e lista `ITENS` com cálculo de totais.

## Não fazer
- Não conectar no Firebird diretamente.
- Não replicar regra de preço/estoque no CRM.
