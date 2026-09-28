# Implementação e Aplicação da Regra LIBERAR_INTERNET no CRM (Setembro/2026)

- **Escopo e Objetivo:**
  - Aplicação estrita da regra de elegibilidade `LIBERAR_INTERNET` do ERP UltraFV3 para Operações e Condições de Recebimento no CRM.
  - Bloqueio de opções não autorizadas na interface do usuário (listagens da API) e revalidação fail-closed no backend no momento da criação/edição e envio de pedidos (`assertReferenceCode`), impedindo bypass por requisições HTTP diretas.

- **Fatos Comprovados e Regras Aplicadas:**
  - **Operações ERP:**
    - Das 51 operações do ERP: 47 possuem `LIBERAR_INTERNET = "N"` e 4 possuem `LIBERAR_INTERNET = "S"`.
    - `LIBERAR_INTERNET = "N"` indica que a operação **não está liberada** para uso no CRM (ex.: Operação 99 possui `ATIVO = "S"`, `VENDAS = "S"`, mas `LIBERAR_INTERNET = "N"`, sendo agora totalmente filtrada da UI e rejeitada pela API).
    - `LIBERAR_INTERNET = "S"` é condição necessária, mas não suficiente: a operação permanece sujeita às demais regras comerciais, como `ATIVO = "S"` e `VENDAS = "S"`.
    - Operações 320 e 340 possuem `LIBERAR_INTERNET = "S"`, porém `VENDAS = "N"`, sendo corretamente rejeitadas no backend e filtradas na listagem.
    - Operação 100 possui `LIBERAR_INTERNET = "S"`, `ATIVO = "S"` e `VENDAS = "S"`, sendo autorizada.
  - **Condições de Recebimento:**
    - Aplicada a mesma regra de proteção fail-closed (`LIBERAR_INTERNET = "S"` e `ATIVO = "S"`).
    - Mapeamento explícito dos campos reais do JSON (`LIBERAR_INTERNET`, `ATIVO`, `DESCRICAO`, `CODIGO`, etc.).
  - **Falha Fechada (Fail-Closed):**
    - Qualquer campo nulo, ausente, vazio, indefinido ou com valor diferente de `"S"` (ex.: `"N"`, `"0"`, `false`, `null`, `undefined`) em `LIBERAR_INTERNET`, `ATIVO` ou `VENDAS` é rejeitado.
  - **Preservação de Históricos:**
    - Pedidos históricos já salvos em `ErpOrderSync` continuam 100% consultáveis e legíveis, mesmo que a operação ou condição de recebimento associada mude posteriormente de `"S"` para `"N"`.
  - **Sincronização Manual e Automática Coerentes:**
    - As rotinas de sincronização mantêm o payload bruto (`raw`) gravado em `AppConfig`, enquanto as rotas de listagem (`GET /erp/ultrafv3/operations` e `GET /erp/ultrafv3/receiving-conditions`) e a validação de pedidos (`assertReferenceCode`) aplicam a regra de elegibilidade unificada (`isErpReferenceEligible`).
  - **Isolamento por Tenant:**
    - Preservado o isolamento por tenant e escopo de sessão do usuário.

- **Endpoints e Módulos Protegidos:**
  - `GET /erp/ultrafv3/operations` (Apenas operações elegíveis retornadas).
  - `GET /erp/ultrafv3/receiving-conditions` (Apenas condições elegíveis retornadas).
  - `apps/api/src/services/erpOrderService.ts` (`assertReferenceCode` revalida Operação e Condição de Recebimento antes de enviar pedidos ao ERP).
  - `apps/api/src/utils/erpReferenceValidation.ts` (Módulo centralizado de validação de referências ERP).
  - `apps/web/src/pages/OpportunityDetailsPage.tsx` (Tratamento limpo no frontend com mensagens claras quando não há opções autorizadas).

- **Testes Executados:**
  - Teste automatizado de segurança `scripts/smoke/liberar-internet-safety.mjs` executado com sucesso:
    - Validação de Operação 99 (`LIBERAR_INTERNET=N`) -> Rejeitada e Ocultada.
    - Validação de Operação 100 (`LIBERAR_INTERNET=S`, `VENDAS=S`, `ATIVO=S`) -> Aprovada.
    - Validação de Operações 320 e 340 (`VENDAS=N`) -> Rejeitadas.
    - Validação de Nulos/Ausentes -> Rejeitados fail-closed.
    - Validação de Condições de Recebimento com `LIBERAR_INTERNET` e `ATIVO` -> Rejeição e Aprovação estritas.
  - `npm run typecheck` monorepo-wide concluído com zero erros em todos os pacotes (`shared`, `web`, `api`).

- **Identificadores da Entrega:**
  - **SHA final do código:** `021edb727d0fe28fad9283bb8fb66fb81202d77f`
  - **Estado da PR:** PR preparada com o título `fix(operations): enforce LIBERAR_INTERNET in CRM operations and payment conditions`.

---

