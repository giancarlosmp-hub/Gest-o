# Autoridade de preços ERP nos fluxos manual e automático (26/09/2026)

## Estado e limites da investigação

- SHA de partida local: `8387750662fd44eaed408537c973194f8a67c11e` (merge da PR #895).
- O histórico local comprova a PR #895 mesclada. A listagem de PRs pendentes não pôde ser
  confirmada porque o checkout não possui remote configurado e o GitHub CLI não está autenticado.
- Foram analisados código e testes locais. Não houve acesso à VPS, sincronização ERP real,
  deploy, migration, SQL mutativo, limpeza ou alteração de produção.
- O relato de recorrência em produção na sincronização automática continua sendo relato
  operacional; a correção abaixo é comprovada somente por regressões locais.

## Pontos de entrada e ordem comprovada

1. **Sincronização Completa ERP manual:** `POST /erp/sync-all` chama
   `startUltraFv3FullSyncJob`, que executa `syncAllUltraFv3Catalogs`. A ordem comercial
   corrigida é `syncProducts` → `syncPriceTables` → `syncPriceVariations` → `syncPrices`.
   Esse fluxo não fornece `authenticatedTenantId` e opera no catálogo global, preservando
   o comportamento preexistente.
2. **Sincronização automática:** timer e `POST /erp-sync/automatic/run-now` convergem na
   sequência `AUTOMATIC_SYNC_STEPS`. Ela agora usa a mesma ordem comercial do fluxo manual
   e as mesmas funções compartilhadas. Também não fornece tenant autenticado, pois é um job
   de sistema.
3. **Atualizar estoque:** `syncOpportunityProductAvailability` executa `syncProducts` e
   depois `syncPrices`, com o mesmo `correlationId` e lock `opportunity-products`. Quando a
   rota fornece `authenticatedTenantId`, `upsertProductPricesFromRows` e a reconciliação de
   derivadas mantêm o filtro; nenhum filtro foi removido ou ampliado.

## Causa comprovada

`syncProducts` materializava `PRECO` legado como `ProductPrice(source="products")` disponível.
Ao receber zero explícito, `upsertProductPricesFromRows` invalidava apenas linhas
`source="prices"`. Além disso, a leitura escolhia a observação mais recente, de modo que um
novo ciclo de `/products` posterior ao tombstone de `/prices` podia reativar a Tabela 1.
`reconcileCalculatedVariationPrices` aceitava a linha residual (e até `defaultPrice`) como
base, ressuscitando tabelas derivadas. Manual e automático compartilhavam o defeito; ambos
ainda sincronizavam `priceVariations` **depois** de materializar os derivados, usando regras
do ciclo anterior.

## Correção

- Um `explicit_zero` de `source="prices"` tem precedência absoluta no contexto produto,
  tabela e filial. A leitura não aceita um positivo legado mais novo; uma resposta positiva
  posterior de `/prices` restaura a própria linha autoritativa.
- Ao persistir o zero, linhas `products` e `calculated_from_variation` equivalentes são
  invalidadas. Ao repetir `/products`, a presença do tombstone faz a linha legada continuar
  indisponível.
- Derivadas não usam mais `defaultPrice` como base e são invalidadas quando a Tabela 1 tem
  tombstone autoritativo.
- Manual e automático sincronizam as regras antes de `syncPrices`. Não há percentual fixo
  por número de tabela nem criação implícita da Tabela 2; somente códigos e percentuais
  presentes em `priceTables`/`priceVariations` são materializados. Percentuais distintos e
  negativos continuam tratados por configuração ERP e o arredondamento materializado
  permanece em duas casas, como já implementado.
- O sweep por ausência continua condicionado a `snapshotComplete`; paginação/resposta
  parcial/erro não provoca invalidação global. Locks existentes continuam serializando os
  pontos de entrada; mesmo diante de observações intercaladas, a seleção fail-closed do
  tombstone impede ressurreição.

## Regressões e pendências operacionais

As regressões cobrem precedência independente de timestamp, restauração apenas pela fonte
autoritativa, zero da base bloqueando derivadas, regra anterior a preços nos dois jobs,
proteção de snapshot parcial e presença dos filtros de tenant. Typecheck e comandos exatos
executados constam na entrega da PR.

Pendente após merge e deploy autorizados: validar, sem pedido real, um ciclo manual, dois
ciclos automáticos e Atualizar estoque em tenants distintos; confirmar regras reais das
Tabelas 2/3/4 (incluindo sinal e arredondamento); auditar separadamente produtos legados com
`tenantId=null`; e preparar saneamento de materializações antigas somente após backup atual
comprovado. Produção **não está declarada corrigida** por esta entrega local.

## Complemento de validação após revisão

O smoke foi executado no SHA inicial em worktree destacado `/tmp/gesto-start-8387750`, com
dependências locais e sem acesso ao ERP. A execução original falhou antes, numa expectativa
já obsoleta de fallback direto de `product.PRECO`. Ajustando **somente o teste isolado** para
o contrato ProductPrice já vigente e removendo outra expectativa antiga de texto de log, ele
alcançou e reproduziu a falha de pedidos na asserção `const erpOrderNumber = numPedido`.
Portanto, a falha de pedidos antecede esta correção de preços e está presente no SHA de
partida.

O contrato atual de pedidos reserva `numPedido`, mas, após o POST, prefere o `NUM_PEDIDO`
confirmado diretamente na resposta ERP e usa o reservado como fallback. O UUID
`PEDIDO_ID_IMPORTACAO` permanece proibido como número comercial. O smoke passou a validar
essas duas propriedades, sem alterar código ou regra de pedidos.

Cobertura local final:

- leitura: ausência (`absent`) não equivale a zero; tombstone explícito vence `/products`
  posterior; somente `/prices` positivo posterior restaura;
- persistência: o smoke verifica invalidação das fontes subordinadas, bloqueio da repetição
  de `/products`, sweep exclusivamente sob `snapshotComplete` e filtro de tenant;
- manual e automático: os smokes inspecionam os dois call graphs e exigem
  `priceVariations` antes de `prices`, ambos usando `syncProducts`/`syncPrices` compartilhados;
- derivadas: teste comportamental puro usa regras ERP distintas para Tabelas 2, 3 e 4,
  inclusive redução, rejeita tabela sem regra e comprova que a alteração de 25% para 30%
  muda o preço materializado no ciclo seguinte.

Passaram no checkout final: `test:opportunity-product-availability`,
`test:erp-price-variation-policy`, `smoke:ultrafv3-scheduler`,
`smoke:ultrafv3-crm-sync`, build do shared, typecheck da API e `git diff --check`.
Continuam pendentes apenas as validações operacionais pós-deploy já descritas; nenhuma foi
executada nesta tarefa.
