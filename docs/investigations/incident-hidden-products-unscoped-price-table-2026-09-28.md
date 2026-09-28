# Investigação e Resolução do Incidente — Produtos Ocultos por Preço sem Tabela (28/09/2026)

## 1. Identificação e Sintoma do Incidente
- **Sintoma Relatado:** Após o deploy e a conclusão com sucesso da Sincronização Completa ERP (`syncAll`), a busca de produtos na tela Nova Oportunidade (`/products/search?priceTableCode=1`) não retornou nenhum item visível, ocultando todos os produtos sob a justificativa de preço inválido.
- **Evidências Read-Only da Produção:**
  - `total_products = 543`, `active_products = 543`.
  - Execução `syncAll`: `status = success_with_warnings`, `products.received = 543`, `products.validAfterNormalization = 543`, `prices.received = 501`, `prices.productFoundRows = 501`, `prices.positivePriceRows = 181`, `prices.explicitZeroRows = 320`, `prices.persistedPriceRows = 501`, `prices.rejectedRows = 0`, `prices.missingProduct = 0`.
  - Endpoint `/products/search` retornou: `receivedFromDatabase = 56`, `inactive = 0`, `not_synchronized = 0`, `invalid_price = 56`, `priceTableCode = 1`, `priceTableMatched = false`, `source = "missing"`, `hiddenReason = "invalid_price"`.
  - Registro de Log no CRM: `"Produto sem preço válido sincronizado para a tabela 1."`.

## 2. Causa Comprovada
- O endpoint `/prices` do UltraFV3 retorna linhas de preço sem campo de tabela explícito no JSON do payload (campos `TABELA` / `CODTABELA` ausentes).
- O normalizador `normalizeErpProductPriceObservation` (em `apps/api/src/services/erpProductPriceObservation.ts`) converte a ausência do código de tabela para `priceTableCode = null`, gravado na tabela `ProductPrice` com `erpPriceId = null`.
- No serviço de seleção de preço (`apps/api/src/services/opportunityPriceService.ts` em `calculateOpportunityPriceForTable`), a regra de filtragem de linhas candidatas continha:
  `normalizeOptionalString(item.erpPriceId) !== ""`
  Esta condição descartava sumariamente todas as linhas de `ProductPrice` com `erpPriceId = null` ou `""`.
- Consequentemente, ao buscar produtos para a Tabela Comercial Padrão (Tabela 1 / `priceTableCode = "1"`), a lista de linhas de preço ficava vazia, fazendo com que o cálculo retornasse `priceTableMatched = false`, `price = 0` e `source = "missing"`.
- O endpoint `/products/search` recebia `priceTableMatched = false`, classificava cada item como inelegível via `isOpportunityProductSelectable` e ocultava 100% dos produtos com `hiddenReason: "invalid_price"`.

## 3. Hipótese Contratual Pendente
- A relação entre as linhas sem tabela retornadas no endpoint `/prices` (chamada base sem parâmetro `?tabela=X`) e a Tabela Comercial Padrão (Tabela 1) é a convenção do conector UltraFV3. No entanto, o payload bruto retornado do ERP não insere um campo `TABELA: "1"` explícito nessa resposta.
- Permanece como hipótese contratual pendente a ser confirmada com a equipe de integração do ERP se futuras versões do UltraFV3 passarão a incluir o campo de tabela explícito (ex.: `TABELA: "1"`) na resposta do `/prices` ou se o parâmetro `/prices?tabela=1` passará a retornar essas mesmas linhas envelopadas.

## 4. Correção Implementada
- Em `apps/api/src/services/opportunityPriceService.ts` (`calculateOpportunityPriceForTable`), a regra de seleção de linhas de preço foi atualizada com regras de precedência e fallback seguros:
  1. **Seleção de Tabela Explícita:** Primeiro, filtra linhas em `ProductPrice` que possuem `erpPriceId` explícito correspondente à tabela solicitada (`priceTableMatches(item.erpPriceId, normalizedPriceTableCode)`).
  2. **Fallback para Tabela Padrão (Tabela 1):** Se a tabela solicitada for a Tabela Comercial Padrão (`priceTableCode = "1"`) e NENHUMA linha de Tabela 1 explícita existir no produto, o serviço utiliza em fallback as linhas sem tabela (`erpPriceId = null` ou `""`).
  3. **Precedência Estrita:** Caso exista uma linha de Tabela 1 explícita (seja um preço positivo ou um zero explícito `availabilityState = "explicit_zero"`), ela mantém prioridade total. Linhas sem tabela NUNCA sobrepõem nem invalidam uma linha explícita da Tabela 1.
  4. **Escopo de Tabelas Secundárias:** Para consultas de tabelas secundárias (Tabela 2, 3, 4, etc.), o fallback de linhas sem tabela NÃO é ativado, exigindo correspondência explícita de tabela ou variação calculada (Camada 2).

## 5. Testes de Regressão e Validação Local
- Atualizada e expandida a suíte de testes em `apps/api/src/services/opportunityProductAvailability.test.ts` cobrindo:
  - Preço sem tabela (`erpPriceId = null`) ativando fallback na busca por Tabela 1 e tornando o produto selecionável em Nova Oportunidade.
  - Preço sem tabela NÃO correspondendo a buscas por tabelas secundárias (Tabela 2).
  - Precedência de Tabela 1 explícita positiva sobre fallback de preço sem tabela.
  - Precedência de Tabela 1 explícita com zero explícito (`explicit_zero`) sobre fallback de preço sem tabela.
  - Correspondência explícita de tabelas 1, 2, 3 e 4.
  - Filtragem de vigência histórica válida vs. vigência futura.
  - Precedência de filial específica vs. filial nula.
  - Testes de integridade das métricas do `assertUsefulProductPriceSync` para Sincronização Completa, Sincronização Automática e "Atualizar estoque".
- **Resultado dos Testes:** Executado via `npx tsx apps/api/src/services/opportunityProductAvailability.test.ts` com resultado `PASS`.

## 6. Limitações
- NENHUM dado de `Product` ou `ProductPrice` foi excluído ou alterado no banco de dados.
- Nenhuma sincronização produtiva ou mutação SQL foi executada no ambiente de produção.
- Linhas sem tabela atuam exclusivamente como fallback para a Tabela Comercial Padrão (Tabela 1) na ausência de registros explícitos para essa mesma tabela.

## 7. Validação Pós-Deploy Necessária
1. Após a implantação do código via workflow oficial de deploy, acessar a tela Nova Oportunidade no CRM.
2. Realizar uma busca de produtos com a Tabela Comercial Padrão (Tabela 1).
3. Verificar se os produtos sincronizados (incluindo aqueles com preços recebidos sem tabela explícita) aparecem na listagem como selecionáveis (`priceTableMatched: true`, `source: "productPrice"`), exibindo seus valores positivos de preço.
