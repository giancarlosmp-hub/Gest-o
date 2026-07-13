# Diagnóstico — NUM_PEDIDO, sincronização automática UltraFV3 e datas de oportunidades

## Escopo investigado

Foram revisados os fluxos de geração de pedido ERP, scheduler automático UltraFV3 e data-only de oportunidades. As buscas obrigatórias foram executadas com `rg` para `NUM_PEDIDO`, `NUMERO_PEDIDO`, `PEDIDO_ID_IMPORTACAO`, `PMR`, scheduler UltraFV3 e usos de `new Date`/`toISOString` nos módulos `apps` e `packages`.

## 1. Causa raiz do NUM_PEDIDO incorreto

O backend consultava `GET /salesmen` imediatamente antes de montar o pedido, mas descartava o `NUMERO_PEDIDO` retornado e sempre chamava um gerador local de número curto para preencher `NUM_PEDIDO`. Esse gerador produzia códigos internos curtos iniciados por `P` (incluindo valores observáveis com padrão `PMR...` conforme timestamp base36), enquanto `PEDIDO_ID_IMPORTACAO` continuava sendo um UUID v4 separado.

### Origem do código PMR

O código `PMR...` era gerado pelo CRM como fallback/local short id para `NUM_PEDIDO`, não pelo ERP. A origem estava na função local removida de geração curta baseada em timestamp/random. O payload real era montado com esse valor em `NUM_PEDIDO` antes de `POST /orders`.

### Payload sanitizado antes

```json
{
  "NUM_PEDIDO": "PMRANWP4PFOFX7",
  "PEDIDO_ID_IMPORTACAO": "uuid-v4-da-tentativa",
  "endpoint": "/orders"
}
```

### Payload sanitizado depois

```json
{
  "NUM_PEDIDO": "3657",
  "PEDIDO_ID_IMPORTACAO": "550da2fc-52e9-40cf-a48d-0f1b4535999e",
  "endpoint": "/orders"
}
```

## 2. Correção aplicada em pedidos ERP

- `PEDIDO_ID_IMPORTACAO` permanece UUID v4 gerado por tentativa lógica.
- `NUM_PEDIDO` passou a receber exclusivamente o `NUMERO_PEDIDO` retornado por `GET /salesmen`, convertido para string.
- O envio é abortado se `NUMERO_PEDIDO` estiver ausente, não numérico, maior que 15 caracteres, igual ao UUID, com hífen/UUID ou com prefixo interno `PMR`.
- O fallback local que colocava código curto do CRM em `NUM_PEDIDO` foi removido.
- O lock global de envio real (`erpOrderSubmissionMutex`) continua envolvendo autenticação, `GET /salesmen`, montagem, persistência, `POST /orders` e finally, impedindo concorrência em processo. Não há evidência no repositório de múltiplas réplicas da API; se produção passar a ter múltiplas instâncias, o próximo passo é promover esse lock para advisory lock PostgreSQL global fora da transação curta.
- Logs continuam sanitizados e registram correlationId, opportunityId, endpoint, `NUM_PEDIDO`, `PEDIDO_ID_IMPORTACAO`, status/duração e falha resumida sem credenciais/token.

## 3. Causa raiz do scheduler parado

O scheduler era inicializado no boot (`server.ts`), mas quando a sincronização estava habilitada e o UltraFV3 não estava configurado no momento do boot, `startErpSyncScheduler()` registrava configuração ausente e retornava antes de registrar o timer. O painel então podia mostrar “backend não inicializado/sem próxima execução” ou status antigo vindo de `AppConfig`/histórico, apesar de integrações manuais por vendedor funcionarem.

Variáveis relevantes:

- `ERP_SYNC_SCHEDULER_ENABLED` habilita/desabilita por ambiente.
- `ULTRAFV3_BASE_URL` é obrigatória para qualquer modo.
- `ULTRAFV3_USERNAME` e `ULTRAFV3_PASSWORD` são obrigatórias para credencial global; quando ausentes, o scheduler pode operar em modo vendedor de referência se houver vendedor ativo com Login FV3/Senha FV3.
- `ERP_CREDENTIAL_ENCRYPTION_KEY` é necessária para credenciais por vendedor.

O `docker-compose.yml` versionado repassa `ULTRAFV3_BASE_URL`, `ULTRAFV3_USERNAME` e `ULTRAFV3_PASSWORD`; não foi feita alteração em credenciais.

## 4. Correção aplicada no scheduler

- Inicialização explícita e idempotente no boot preservada.
- Scheduler agora permanece vivo quando há configuração ausente: calcula `nextRunAt`, registra log claro e, no tick seguinte, reporta skip por configuração sem matar o timer.
- Status seguro expõe: `enabled`, `initialized`, `running`, `lastTickAt`, `lastStartedAt`, `lastFinishedAt`, `lastSuccessAt`, `lastErrorAt`, `lastError`, `nextRunAt`, `timezone`, `window`, `frequencyMinutes`, `authConfigured`, `referenceSellerConfigured` e `missingConfig`.
- Cada execução continua com try/catch/finally e `automaticSyncRunning = false` no finally.
- A rota restrita `POST /erp-sync/automatic/run-now` reutiliza a mesma função do scheduler, respeitando lock/estado e retornando resumo seguro.

### Como testar em produção

1. Verificar `GET /erp/ultrafv3/scheduler/status` como diretor/gerente.
2. Conferir `missingConfig`, `authConfigured`, `referenceSellerConfigured` e `nextRunAt`.
3. Executar `POST /erp-sync/automatic/run-now` como diretor/gerente.
4. Conferir logs `[ultrafv3 scheduler] tick`, `run started`, `run finished` ou `skipped` com motivo.

## 5. Causa raiz da data -1 dia

Campos comerciais date-only eram tratados no frontend com `new Date(value)` e formatados por `Intl.DateTimeFormat`. Strings `YYYY-MM-DD`/ISO à meia-noite UTC podem renderizar como o dia anterior em `America/Sao_Paulo`. O backend filtra os dois campos de intervalo em `proposalDate`, que é a Data de entrada da oportunidade.

## 6. Correção aplicada nas datas/filtros

- `formatDateBR` agora formata strings ISO/date-only usando diretamente o componente `YYYY-MM-DD`, sem conversão de fuso.
- `toDateInput` reaproveita `YYYY-MM-DD` direto para inputs date.
- `toDayStart` interpreta date-only como data local para comparações de UI.
- Os filtros receberam rótulos claros: “Data de entrada — de” e “Data de entrada — até”.
- Não houve migration nem alteração automática de dados históricos.

## Risco e rollback

- Risco de pedidos: baixo/médio; a mudança bloqueia envios quando o ERP não fornece sequência válida em vez de enviar valor incorreto.
- Risco do scheduler: baixo; passa a manter o timer ativo e expor diagnóstico em vez de morrer por configuração ausente.
- Risco de datas: baixo; mudança concentrada em renderização/parse frontend date-only, sem migration.

Rollback: reverter o commit desta PR. Em produção, caso pedidos sejam bloqueados por `NUMERO_PEDIDO` ausente, validar `/salesmen` e credenciais do vendedor antes de liberar novo envio.
