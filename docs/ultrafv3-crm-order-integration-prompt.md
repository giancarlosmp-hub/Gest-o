# Prompt pronto — integração de pedidos do CRM com UltraFV3

## Objetivo
Fazer o CRM enviar pedidos para o ERP **exclusivamente** via API UltraFV3 (porta `8585`), sem conexão direta no Firebird.

## Regras obrigatórias
- Não conectar o CRM diretamente no banco Firebird.
- Não implementar no CRM regras de preço/estoque que já pertencem ao UltraFV3/ERP.
- Preservar sempre `PEDIDO_ID_IMPORTACAO` (UUID v4) como chave de rastreio e idempotência.

## Variável de ambiente
- `ULTRAFV3_BASE_URL=http://[IP_DO_SERVIDOR_WINDOWS]:8585`

## Fluxo a implementar
1. **Login**: `POST /auth/login` com `username`/`password`, armazenando JWT Bearer.
2. **Dados de referência** (antes do envio):
   - `GET /salesmen`
   - `GET /partners`
   - `GET /products`
   - `GET /priceTables`
   - `GET /paymentMethods`
   - `GET /receivingConditions`
   - `GET /branches`
   - `GET /operations`
3. **Enviar pedido**: `POST /orders` com payload completo no contrato UltraFV3.
4. **Consultar status**: `GET /orderStatus`.

## Requisitos de implementação no CRM
1. Serviço de autenticação UltraFV3 com cache de token e renovação automática.
2. Na ação “Enviar Pedido”:
   - gerar UUID v4 para `PEDIDO_ID_IMPORTACAO`;
   - montar payload completo no formato UltraFV3;
   - formatar datas em `DD.MM.YYYY` (ex.: `28.04.2026`);
   - enviar com `Authorization: Bearer <token>`;
   - salvar no banco do CRM: status (`enviado`/`erro`), UUID e resposta da API.
3. Tratamento de erros:
   - em `401`, renovar token e repetir **uma única vez**;
   - em erro da API, persistir status `erro` com mensagem;
   - impedir duplicação usando `PEDIDO_ID_IMPORTACAO` como idempotência.
4. Campo `OPERADOR` deve ser o usuário logado no CRM mapeado para o operador correspondente no ERP.

## Checklist de validação
- Pedido enviado pelo CRM aparece no mesmo fluxo consumido hoje pelo app de força de vendas.
- Reenvio acidental com o mesmo `PEDIDO_ID_IMPORTACAO` não cria novo pedido.
- Datas e totais aceitos pelo UltraFV3 sem transformação manual no ERP.
- Logs do CRM guardam request id (UUID), resposta e status final.
