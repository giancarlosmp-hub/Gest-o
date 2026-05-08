# Checklist de deploy produção — integração ERP UltraFV3

Objetivo: liberar primeiros pedidos reais com foco em estabilidade operacional, rastreabilidade e reversão segura.

## 1. Banco e migrations

- [ ] Executar backup do PostgreSQL antes do deploy.
- [ ] Validar `prisma migrate status` contra o banco de produção.
- [ ] Confirmar aplicação das migrations de vínculo ERP do usuário e histórico de pedidos ERP.
- [ ] Confirmar que a tabela `ErpOrderSync` existe e possui índices para `pedidoIdImportacao`, `opportunityId/createdAt`, `status`, `orderStatus` e `numPedido`.
- [ ] Confirmar que `User.erpCode` e `User.erpOperatorCode` estão preenchidos para todos os vendedores que poderão gerar pedidos.

## 2. Configuração UltraFV3

- [ ] Conferir `ULTRAFV3_BASE_URL`, `ULTRAFV3_USERNAME` e `ULTRAFV3_PASSWORD` no ambiente da API.
- [ ] Reiniciar a API depois de alterar qualquer segredo/variável de ambiente.
- [ ] Validar o card/rota de conexão UltraFV3 antes de sincronizar cadastros.
- [ ] Confirmar que a conta UltraFV3 tem permissão para `/auth/login`, `/salesmen`, `/orders` e `/orderStatus`.

## 3. Sincronização pré-pedido

- [ ] Sincronizar produtos e revisar rejeições por código, unidade, preço, inatividade/suspensão e estoque zerado.
- [ ] Sincronizar parceiros/clientes e revisar vínculos de vendedor por código ERP.
- [ ] Sincronizar vendedores, formas de pagamento, condições, tabelas, filiais e operações.
- [ ] Revisar `/erp/ultrafv3/sync/status` e garantir que todos os escopos necessários estejam em `success`.

## 4. Validação operacional do primeiro pedido

- [ ] Selecionar uma oportunidade `ganho` com cliente que tenha código ERP.
- [ ] Confirmar que todos os itens possuem produto ERP, classificação, unidade, quantidade, preço e totais coerentes.
- [ ] Confirmar que o vendedor CRM possui `CODVENDEDOR` e `OPERADOR` ERP.
- [ ] Gerar somente um pedido por oportunidade e aguardar resposta da API.
- [ ] Conferir no log o `pedidoIdImportacao`, `numPedido`, `erpOrderSyncId`, `opportunityId`, vendedor e operador.
- [ ] Conferir no ERP se o pedido foi criado com o mesmo `NUM_PEDIDO`/número retornado.

## 5. Monitoramento e recuperação

- [ ] Monitorar logs `[ultrafv3 http]`, `[erp order]`, `[erp order status]` e `[ultrafv3 sync]` durante a janela de deploy.
- [ ] Em falha de `/orders`, consultar `ErpOrderSync.syncErrors` antes de reenviar a oportunidade.
- [ ] Em falha de `/orderStatus`, executar nova sincronização depois de confirmar disponibilidade UltraFV3.
- [ ] Em erro 401/403, revisar credenciais/permissões UltraFV3 e reiniciar a API para limpar estado de token.
- [ ] Em timeout/indisponibilidade, confirmar se o UltraFV3 não criou pedido antes de liberar novo envio.

## 6. Critérios de rollback/pausa

- [ ] Pausar novos envios se houver divergência entre `ErpOrderSync` e pedidos criados no ERP.
- [ ] Pausar novos envios se `/salesmen` retornar `NUM_PEDIDO` vazio/inválido para vendedores ativos.
- [ ] Pausar novos envios se houver repetição de `NUM_PEDIDO` para oportunidades diferentes.
- [ ] Reverter deploy se logs não permitirem rastrear `pedidoIdImportacao` ou se o histórico `ErpOrderSync` não persistir.
