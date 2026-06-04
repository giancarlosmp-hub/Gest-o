# Checklist operacional — primeira sincronização UltraFV3

Objetivo: executar a primeira sincronização segura em produção/preview após o merge da integração UltraFV3, sem habilitar pedidos reais antes da validação mínima de credenciais, cadastros e diagnóstico.

## Pré-condições obrigatórias

- [ ] Confirmar que o deploy atual contém as migrations Prisma da integração ERP aplicadas com sucesso.
- [ ] Confirmar que a API iniciou sem exigir `ULTRAFV3_BASE_URL`, `ULTRAFV3_USERNAME` e `ULTRAFV3_PASSWORD` quando a integração ainda não estiver configurada.
- [ ] Confirmar que **Configurações > Integração ERP** mostra `Configuração ausente` e lista exatamente as variáveis faltantes antes da configuração real.
- [ ] Confirmar que os endpoints administrativos `/erp/ultrafv3/*` e `/erp/ultrafv3/sync/*` respondem somente para usuários autenticados com perfil `diretor` ou `gerente`.
- [ ] Confirmar que `ERP_SYNC_SCHEDULER_ENABLED` só ficará ativo quando as três variáveis UltraFV3 estiverem preenchidas e validadas.

## Ordem operacional da primeira sincronização

1. **Backup**
   - [ ] Executar backup do PostgreSQL de produção/preview antes de aplicar credenciais reais ou rodar sync.
   - [ ] Registrar horário, responsável e local seguro do arquivo de backup.

2. **Configurar variáveis**
   - [ ] Configurar `ULTRAFV3_BASE_URL` na API.
   - [ ] Configurar `ULTRAFV3_USERNAME` na API.
   - [ ] Configurar `ULTRAFV3_PASSWORD` na API.
   - [ ] Reiniciar a API depois de alterar variáveis/segredos.
   - [ ] Abrir **Configurações > Integração ERP** e confirmar que não há variáveis faltantes.

3. **Testar health**
   - [ ] Executar o card **Conexão UltraFV3** ou `POST /erp/ultrafv3/sync/connection` com usuário `diretor`/`gerente`.
   - [ ] Confirmar status `success`, ausência de erro 401/403 e `correlationId` registrado.

4. **Sincronizar vendedores**
   - [ ] Executar o card **Vendedores**.
   - [ ] Conferir se os códigos `CODVENDEDOR` e operadores retornados são suficientes para vincular usuários CRM.

5. **Sincronizar clientes**
   - [ ] Executar o card **Clientes/parceiros**.
   - [ ] Revisar clientes sem código, sem cidade/UF ou com vendedor ERP não mapeado.

6. **Sincronizar produtos**
   - [ ] Executar o card **Produtos**.
   - [ ] Revisar diagnósticos de produtos inativos, suspensos, sem código, sem unidade, sem preço ou sem estoque.

7. **Sincronizar formas/condições/tabelas/filiais/operações**
   - [ ] Executar **Formas de pagamento**.
   - [ ] Executar **Condições de pagamento**.
   - [ ] Executar **Tabelas de preço**.
   - [ ] Executar **Filiais**.
   - [ ] Executar **Operações**.
   - [ ] Confirmar que todos os catálogos necessários ficaram em `success` no painel.

8. **Vincular usuários CRM aos vendedores/operadores ERP**
   - [ ] Atualizar cada usuário vendedor com `erpCode`/`CODVENDEDOR`.
   - [ ] Atualizar cada usuário vendedor com `erpOperatorCode`/`OPERADOR`.
   - [ ] Validar que somente vendedores habilitados para pedido real possuem vínculo completo.

9. **Simular pedido ERP**
   - [ ] Selecionar uma oportunidade `ganho` controlada, com cliente ERP e itens válidos.
   - [ ] Gerar pedido com **Simulação ERP** ativada.
   - [ ] Conferir payload, `NUM_PEDIDO`, vendedor, operador, filial, operação, forma, condição e tabela sem enviar `/orders` real.
   - [ ] Testar o debug aberto por navegador com query string completa, por exemplo: `/api/opportunities/:id/erp/debug-payload?paymentMethodCode=1&receivingConditionCode=1&priceTableCode=1&branchCode=1&operationCode=100`.
   - [ ] Conferir que o JSON do debug retorna `paramsReceived`, `paramsResolved`, `missingParams`, `payload`, `salesmenDiagnostics` e `postOrdersSent: false`.

10. **Enviar primeiro pedido real controlado**
    - [ ] Remover **Simulação ERP** somente após validação do payload.
    - [ ] Enviar uma única vez e aguardar resposta.
    - [ ] Registrar `pedidoIdImportacao`, `numPedido`, `erpOrderSyncId`, `opportunityId`, usuário executor e horário.
    - [ ] Não reenviar automaticamente em caso de timeout/erro; antes, consultar o ERP e o histórico `ErpOrderSync` para evitar duplicidade.

11. **Consultar orderStatus**
    - [ ] Executar **Status de pedidos** ou `POST /erp/ultrafv3/sync/order-status`.
    - [ ] Confirmar que o pedido real aparece com status normalizado (`pendente`, `faturado`, `parcial`, `cancelado` ou `entregue`).
    - [ ] Registrar divergências entre CRM e ERP antes de liberar novos pedidos reais.

## Critérios de bloqueio

- [ ] Bloquear sync agendado se qualquer variável UltraFV3 estiver ausente.
- [ ] Bloquear pedidos reais se `/health`, vendedores, produtos, clientes ou catálogos comerciais estiverem com erro.
- [ ] Bloquear reenvio de pedido se houver `ErpOrderSync` pendente/enviado para a oportunidade.
- [ ] Bloquear retry manual de `/orders` até confirmar no ERP se o pedido foi criado.
