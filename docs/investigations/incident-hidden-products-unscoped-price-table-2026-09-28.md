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
- No serviço de seleção de preço (`apps/api/src/services/opportunityPriceService.ts` em `calculateOpportunityPriceForTable`), a materialização do catálogo `/products` gera registros `ProductPrice` com `source = "products"`, `erpPriceId = "1"` e `price = 0` (zero estrutural de catálogo, sem metadados de vigência comercial ou ID do ERP).
- A verificação de linhas explícitas para a Tabela 1 considerava esses zeros estruturais de `/products` como se fossem preços comerciais explícitos.
- Como o produto possuía a linha estrutural com `erpPriceId = "1"`, a lista de linhas explícitas para a Tabela 1 ficava com tamanho 1, bloqueando a avaliação de `unscopedFallbackRows` (fallback para preços sem tabela recebidos do `/prices`).
- Consequentemente, as observações comerciais válidas recebidas do `/prices` sem código de tabela (`erpPriceId = null`, valor R$ 128,00 vigente) eram desconsideradas na seleção para a Tabela 1, fazendo com que o cálculo retornasse `price = 0`, `priceTableMatched = false` e `source = "missing"`.
- O endpoint `/products/search` recebia `priceTableMatched = false`, classificava cada item como inelegível via `isOpportunityProductSelectable` e ocultava 100% dos produtos com `hiddenReason: "invalid_price"`.

## 3. Hipótese Contratual Pendente
- A relação entre as linhas sem tabela retornadas no endpoint `/prices` (chamada base sem parâmetro `?tabela=X`) e a Tabela Comercial Padrão (Tabela 1) é a convenção do conector UltraFV3. No entanto, o payload bruto retornado do ERP não insere um campo `TABELA: "1"` explícito nessa resposta.
- Permanece como hipótese contratual pendente a ser confirmada com a equipe de integração do ERP se futuras versões do UltraFV3 passarão a incluir o campo de tabela explícito (ex.: `TABELA: "1"`) na resposta do `/prices` ou se o parâmetro `/prices?tabela=1` passará a retornar essas mesmas linhas envelopadas.

## 4. Distinção entre Zero Estrutural de Catálogo e Zero Comercial Autoritativo
- **Zero Estrutural de Catálogo (Legado e Atual):**
  - Origem: `source = "products"` ou `source = "legacy"`, `price = 0` (ou nulo/undefined), sem `validFrom`, sem `sourceChangedAt`, sem `erpSourcePriceId`.
  - Semântica: Representa a inicialização do item no catálogo (incluindo dados criados antes da migration `20260911190000_product_price_authority` gravados com `source = "legacy"`), não uma decisão comercial de preço.
  - Regra: **NÃO bloqueia** o fallback de preços comerciais positivos recebidos de `/prices` sem tabela para a Tabela 1.
- **Zero Comercial Autoritativo:**
  - Origem: `source = "prices"`, `availabilityState = "explicit_zero"`, com metadados/relógio comercial do ERP.
  - Semântica: Representa um tombstone comercial explícito definido no ERP.
  - Regra: **Permanece respeitado** como tombstone e oculta o produto na busca comercial.

## 5. Regras para Tabelas 1, 2, 3 e 4
- **Tabela 1:** Seleciona a observação comercial vigente de R$ 128,00 de `/prices`, ignorando o registro histórico de R$ 252,08 da filial 1 (2022) e o zero estrutural de `/products`.
- **Tabelas 2, 3 e 4:** O CRM **NÃO** inventa nem possui percentuais fixos ou hardcoded no código. As regras e percentuais vêm exclusivamente do agendador/sincronização do ERP (`AppConfig.erp.ultrafv3.priceVariations` e `reconcileCalculatedVariationPrices`).
  - Para o caso do Marandu (`1 / 9`), a regra de 25% sincronizada do ERP aplicada sobre a base da Tabela 1 (R$ 128,00) resulta no valor de R$ 160,00 para a Tabela 2.
  - As Tabelas 3 e 4 utilizam estritamente suas respectivas regras percentuais e condições sincronizadas do ERP.

## 6. Correção Implementada
- Em `apps/api/src/services/opportunityPriceService.ts` (`calculateOpportunityPriceForTable`), a regra de seleção de linhas de preço foi atualizada:
  1. **Filtragem de Linhas Comerciais Explícitas:** Filtra `explicitTableRows` para ignorar zeros estruturais de catálogo (`isStructuralZeroFromProducts(item)`), gerando `explicitCommercialTableRows`.
  2. **Fallback para Tabela Padrão (Tabela 1):** Se `explicitCommercialTableRows.length === 0` na busca por Tabela 1, aciona `unscopedFallbackRows` contendo as observações comerciais sem tabela de `/prices`.
  3. **Precedência Estrita:** Se existir um zero comercial explícito de `/prices` (`source = "prices"`), ele é mantido como tombstone e bloqueia o fallback.
  4. **Tabelas Secundárias (2, 3 e 4):** Utilizam regras percentuais sincronizadas do ERP (`priceVariations`) sobre a base da Tabela 1 ou linhas explicitamente escopadas.

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
