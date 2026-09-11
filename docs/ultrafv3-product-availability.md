# Contrato UltraFV3 de catálogo, preço e disponibilidade

**Vigência:** 11/09/2026. Este documento descreve o contrato implementado e separa fatos do código de hipóteses que somente uma resposta sanitizada do conector pode confirmar.

## Fontes, identidade e ordem

| Informação | Fonte UltraFV3 | Destino CRM |
|---|---|---|
| código, classificação, descrições, unidade, marca, estado e estoque | `GET /products` (`CODPRODUTO`, `CODPRODUTO_CLAS`, `DSCPRODUTO`, `DSCPRODUTO_CLAS`, `UND_MEDIDA`, `MARCA`, flags de estado e `QTD_ESTOQUE`, com aliases tolerados) | `Product` e `rawErpPayload` |
| preço autoritativo por produto/classificação/tabela/filial | `GET /prices` e preços explicitamente associados a tabela em `/products` | `ProductPrice` |
| catálogo de tabelas e filiais | `GET /price-tables` (alias `/priceTables`) e `GET /branches` | `AppConfig` |

A identidade de catálogo é o par `erpProductCode + erpProductClassCode`; portanto `1/9`, `1/12`, `1/13` e `1/19` são quatro SKUs distintos. A identidade de preço acrescenta tabela e filial. O tenant vem exclusivamente do contexto autenticado, nunca do payload ERP. O schema já contém `Product.brand`; não foi criada migration duplicada. O campo é atualizado a partir de `MARCA` (ou aliases) e retornado pela pesquisa.

O fluxo mínimo para oportunidades é, obrigatoriamente, **produtos → preços**. `/products` atualiza catálogo, estado, marca e estoque; `/prices` reconcilia a autoridade comercial. A sincronização completa de Configurações usa a mesma ordem (com tabelas entre os dois passos). O botão **Atualizar estoque** chama o fluxo mínimo conjunto; ele não atualiza mais apenas `/products`.

## Regra de seleção

O backend da pesquisa é a barreira definitiva. Um resultado requer produto sincronizado, código e classificação, tenant/contexto corretos, ativo, não suspenso e uma linha `ProductPrice` estritamente positiva para a tabela solicitada (tabela `1` por padrão) e filial solicitada quando presente. Estoque zero não elimina o item: ele continua visível como **Sem saldo**.

`Product.defaultPrice`, `Product.minPrice`, `rawErpPayload`, `AppConfig`, variações e o cache de `/prices` não são fontes alternativas de disponibilidade. Eles permanecem para auditoria/compatibilidade, mas jamais ressuscitam um preço ausente, inválido ou zerado. Preço zero explícito cria/atualiza a linha autoritativa com zero e prevalece sobre duplicatas positivas antigas do mesmo contexto.

## Snapshot e falhas

Uma resposta bem-sucedida em array é o formato de snapshot integral atualmente contratado pelo conector. Em resposta envelopada, a varredura de ausentes só é autorizada quando não há `hasNext`/`nextPage` e a quantidade lida alcança `total`/`totalCount`/`count`, quando informado. Timeout, resposta vazia, página seguinte ou total incompleto falham ou são classificados como parciais e **não** invalidam em massa registros não vistos. Uma execução repetida faz upsert nas mesmas identidades e mantém o resultado (idempotência).

O repositório não contém credenciais nem uma captura atual de produção. Assim, não é possível afirmar aqui se `1/12` e `1/13` chegam com zero ou deixam de vir. O endpoint read-only sanitizado de diagnóstico deve ser usado após o deploy para distinguir os casos, sem registrar payload comercial completo. Se o ERP ainda retornar valor positivo na tabela/filial efetiva, o CRM o mantém e a divergência deve ser corrigida na fonte — nunca ocultada por código especial para MARANDU.

## Causa raiz comprovada no código anterior

1. **Atualizar estoque** chamava somente a sincronização de `/products`, sem reconciliar `/prices`.
2. A extração de preços de `/products` descartava zero, deixando a linha positiva anterior de `ProductPrice` intacta.
3. O cálculo da oportunidade consultava, em cascata, `ProductPrice`, preço do payload bruto, cache de preços calculados e `defaultPrice`; logo um valor antigo podia sobreviver nessas origens.
4. A varredura de ausentes em `/prices` era executada sem uma prova explícita de completude da resposta.

Esses mecanismos explicam como `1/12` e `1/13` podiam continuar elegíveis. Registros históricos de `OpportunityItem` e pedidos não são apagados nem reescritos; a mudança afeta apenas novas seleções.

## Validação curta pós-deploy

1. Confirme o SHA do preview e faça login no tenant de teste.
2. Abra **Oportunidades → Nova/Editar**, mantenha a tabela `1` e toque em **Atualizar estoque**; aguarde a confirmação de catálogo, preços e estoque.
3. Pesquise `MARANDU`: valide código/classe, duas descrições, marca, unidade, preço e estoque. No cenário informado, somente `1/9` (R$ 128, estoque 411) e `1/19` (R$ 296, estoque 85) aparecem; `1/12` e `1/13` não aparecem após zero/ausência autoritativa.
4. Em uma fixture com preço positivo e estoque zero, confirme que o item aparece com **Sem saldo**.
5. Um diretor/gerente pode consultar o diagnóstico sanitizado para os quatro códigos e confirmar endpoint, tabela e classificação. Não execute pedido real e não faça escrita manual em produção.
