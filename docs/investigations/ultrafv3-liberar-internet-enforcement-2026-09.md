# Investigação e Resolução: Regra LIBERAR_INTERNET no CRM (Setembro/2026)

## 1. Resumo Executivo
Esta investigação registra a análise, implementação e testes automatizados da regra comercial `LIBERAR_INTERNET` proveniente das tabelas e cadastros do ERP UltraFV3 para Operações, Condições de Recebimento e Formas de Pagamento no CRM Gest-o.

## 2. Fatos Comprovados
1. **Contagens e Análise do Cadastro de Operações ERP:**
   - Existem 51 registros de operações no cadastro sincronizado do ERP.
   - 47 operações possuem `LIBERAR_INTERNET = "N"`.
   - 4 operações possuem `LIBERAR_INTERNET = "S"`.
2. **Semântica do Campo `LIBERAR_INTERNET` e `ATIVO`:**
   - `LIBERAR_INTERNET = "N"` significa estritamente que a operação/condição/forma **não deve estar disponível para uso no CRM**.
   - `LIBERAR_INTERNET = "S"` indica que a opção é **elegível**, mas permanece sujeita a todas as demais regras comerciais (`ATIVO = "S"`, `VENDAS = "S"`, etc.).
   - `ATIVO` exige estritamente `"S"`. Qualquer outro valor (ex.: `"N"`, `"X"`, `"0"`, `"INVALID"`, nulo) falha fechado.
3. **Análise de Operações Específicas:**
   - **Operação 99 (Venda Condicional):** Possui `ATIVO = "S"`, `VENDAS = "S"`, mas `LIBERAR_INTERNET = "N"`. Anteriormente aparecia no seletor do CRM e agora foi **bloqueada e ocultada**.
   - **Operação 100 (Vendas):** Possui `ATIVO = "S"`, `VENDAS = "S"` e `LIBERAR_INTERNET = "S"`. Permanece **autorizada e elegível**.
   - **Operações 320 e 340:** Possuem `LIBERAR_INTERNET = "S"`, porém `VENDAS = "N"`. São **rejeitadas** e ocultadas da listagem por violarem a regra comercial de vendas.
4. **Tratamento de Campos Ausentes, Nulos ou Inválidos:**
   - Aplicado o princípio de segurança *fail-closed*: qualquer registro com `LIBERAR_INTERNET` ausente, nulo, em branco, indefinido ou diferente de `"S"` (ex.: `"N"`, `"0"`, `false`) é sumariamente rejeitado e filtrado para `operations` e `receivingConditions`.
5. **Formas de Pagamento (`paymentMethods` / FORMA):**
   - No payload do pedido (`POST /orders`), a forma de pagamento é enviada como o número `FORMA`.
   - Na validação de referência, `paymentMethods` é revalidado no backend (`assertReferenceCode("paymentMethods")`) e filtrado na listagem (`GET /erp/ultrafv3/payment-methods`).
   - Se o campo `LIBERAR_INTERNET` estiver presente no registro da forma de pagamento, é exigido `LIBERAR_INTERNET = "S"`. Caso o campo seja ausente no payload retornado pelo ERP, a regra recorre obrigatoriamente a `ATIVO = "S"`.
6. **Comportamento para Pedidos Históricos:**
   - A mudança de um código de `"S"` para `"N"` bloqueia novos usos/criações, mas **preserva integralmente os pedidos e oportunidades históricos já persistidos** em `ErpOrderSync`, sem reescrever ou alterar registros antigos legitimamente gravados.
7. **Condições de Recebimento:**
   - Aplicada a mesma proteção fail-closed (`LIBERAR_INTERNET = "S"` e `ATIVO = "S"`), utilizando o mapeamento dos campos reais extraídos do payload JSON (`LIBERAR_INTERNET`, `ATIVO`, `DESCRICAO`, `CODIGO`, etc.).

## 3. Endpoints e Módulos Protegidos
- **Modulo de Validação Centralizado:** `apps/api/src/utils/erpReferenceValidation.ts` (`isErpReferenceEligible`).
- **Endpoints de Listagem Protegidos:**
  - `GET /erp/ultrafv3/operations`
  - `GET /erp/ultrafv3/receiving-conditions`
  - `GET /erp/ultrafv3/payment-methods`
  (Todos filtram em tempo de execução apenas opções elegíveis usando `toReferenceOptions`).
- **Endpoint de Criação/Edição e Envio de Pedidos ao ERP:**
  - `apps/api/src/services/erpOrderService.ts` (`assertReferenceCode`). Revalida no backend a Operação, Condição de Recebimento e Forma de Pagamento antes de gravar ou transmitir o pedido ao ERP, impedindo que chamadas HTTP diretas contornem a interface do usuário.
- **Frontend / Interface do Usuário:**
  - `apps/web/src/pages/OpportunityDetailsPage.tsx` exibindo mensagens informativas limpas e alertas quando não há opções autorizadas ativas.

## 4. Testes Executados
- Criada e executada a suíte de testes automatizados `scripts/smoke/liberar-internet-safety.mjs`:
  - Operação 99 (`LIBERAR_INTERNET=N`) -> Ocultada e Rejeitada via API.
  - Operação 100 (`LIBERAR_INTERNET=S`, `VENDAS=S`, `ATIVO=S`) -> Aprovada.
  - Operações 320 e 340 (`VENDAS=N`) -> Rejeitadas.
  - Campos nulos, vazios ou ausentes -> Rejeitados fail-closed.
  - Condições de recebimento -> Rejeição e aprovação estritas.
- Executada verificação de tipos TypeScript em todo o monorepo (`npm run typecheck`), sem nenhum erro em `@salesforce-pro/shared`, `apps/web` ou `apps/api`.

## 5. Estado do Repositório e PR
- **SHA final do código:** `021edb727d0fe28fad9283bb8fb66fb81202d77f`
- **Título da PR sugerido:** `fix(operations): enforce LIBERAR_INTERNET in CRM operations and payment conditions`
