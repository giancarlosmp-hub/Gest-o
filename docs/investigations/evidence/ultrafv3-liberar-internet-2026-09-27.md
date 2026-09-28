# Evidência sanitizada — `LIBERAR_INTERNET` (27/09/2026)

## Classe e limites

Evidência fornecida pelo operador por screenshots e contagens; os JSONs completos não estão neste
checkout e não foram inspecionados nesta tarefa. Não contém credenciais nem payload integral.

## Contrato confirmado pelo operador

- `LIBERAR_INTERNET=N`: opção não autorizada para uso no CRM.
- `LIBERAR_INTERNET=S`: opção elegível, ainda sujeita às demais regras comerciais.
- `2026-09-27-18-00-33-operations-GET.json`: envelope informado `response.data.data`, 51 operações,
  sendo 47 `N` e 4 `S`.
- Operação 99, VENDA CONDICIONAL: `ATIVO=S`, `LIBERAR_INTERNET=N`; screenshot do CRM mostra 99 no
  seletor.
- Operação 100, VENDAS: `ATIVO=S`, `LIBERAR_INTERNET=S`.
- Códigos com `S`: 100, 101, 320 e 340. Isso não basta para autorizar todos: 320 e 340 têm `VENDAS=N`.
- O operador confirmou a mesma regra de `LIBERAR_INTERNET` para condições de recebimento. O
  screenshot da rota contém o campo; cardinalidade/valores dependem do JSON correspondente.

## Rastreamento no código atual

1. `syncOperations` e `syncReceivingConditions` fazem GET e `syncReferenceData` grava cada linha bruta
   em `AppConfig` (`erp.ultrafv3.operations`/`receivingConditions`); portanto o campo é preservado no
   cache quando presente.
2. `GET /erp/ultrafv3/operations` e `/receiving-conditions` normaliza código/nome, inclui a linha em
   `raw`, mas não interpreta nem filtra `LIBERAR_INTERNET`.
3. `OpportunityDetailsPage.toErpOptions` descarta `raw` e não transporta o campo; por isso opções `N`
   aparecem no seletor. Essa é uma falha de listagem/elegibilidade.
4. Antes de `POST /orders`, `assertReferenceCode` apenas confirma que o código da operação existe no
   cache. Condição de recebimento nem passa por validação equivalente. Não há revalidação de
   `LIBERAR_INTERNET`; uma requisição direta pode contornar a interface. Essa é uma falha separada de
   autorização backend.
5. Sincronização manual e scheduler atualizam os mesmos caches, mas nenhuma aplica a regra.

## Escopo da tarefa seguinte — não implementado nesta correção de preços

- normalizar `S` como elegível e tratar ausente/nulo/inválido como não autorizado até contrato;
- manter filtros adicionais (`ATIVO`, `VENDAS` e demais regras comprovadas), sem concluir que todo `S`
  pode ser usado em qualquer pedido;
- omitir/desabilitar opções `N` no seletor e revalidar no backend imediatamente antes do envio,
  inclusive requisição direta por ID;
- aplicar a regra a operações e condições de recebimento, nos ciclos manual e automático;
- tratar mudança `S→N` sem reescrever pedidos históricos; novos envios deixam de aceitar o código;
- adicionar fixtures sanitizadas dos envelopes reais e testes de UI/API/pedido sem chamar o ERP.

## Critérios de aceite

JSON sanitizado de condições recebido; envelope/aliases confirmados; lista só apresenta elegíveis;
backend rejeita `N`, ausente, nulo e inválido; `S` continua sujeito aos demais filtros; mudança de
estado após sync é respeitada; pedidos históricos permanecem legíveis; nenhum pedido real é enviado.
