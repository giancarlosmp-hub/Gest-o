# Plano técnico — produtos em oportunidades e geração futura de pedidos (ERP Ultra Sistemas / Ultra FV3)

## Contexto e objetivo desta PR

Este documento consolida um diagnóstico técnico do estado atual do CRM e propõe uma evolução incremental para:

1. permitir **itens de produto** dentro da oportunidade;
2. preparar a base para **geração de pré-pedido/pedido** compatível com ERP Ultra Sistemas / Força de Vendas Ultra FV3.

> **Fora de escopo desta PR**: alteração de banco, alteração de API produtiva e integração real com ERP.

---

## 1) Diagnóstico do modelo atual de oportunidades no CRM

### 1.1 Entidade atual (`Opportunity`) e campos

No backend (Prisma), a oportunidade hoje possui os campos centrais abaixo:

- identificação/comercial: `id`, `title`, `value`, `stage`, `probability`, `notes`, `createdAt`;
- contexto técnico: `crop`, `season`, `areaHa`, `productOffered`, `plantingForecastDate`, `expectedTicketPerHa`;
- datas comerciais: `proposalDate`, `followUpDate`, `expectedCloseDate`, `closedAt`, `lastContactAt`;
- relacionamentos: `clientId`/`client`, `ownerSellerId`/`ownerSeller`.

Além disso, `stage` já contempla fechamento ganho/perdido (`ganho`, `perdido`).

### 1.2 Cliente vinculado

A oportunidade é obrigatoriamente vinculada a cliente via `clientId` no modelo.

No cadastro de cliente, já existem campos úteis para integração ERP:

- `code` (código ERP do cliente, quando preenchido);
- `cnpj` e normalizados;
- metadados de ERP, como `erpUpdatedAt`, `lastPurchaseDate`, `lastPurchaseValue`.

### 1.3 Vendedor vinculado

A oportunidade é vinculada a vendedor responsável por `ownerSellerId`.

### 1.4 Valor da oportunidade

Hoje o valor consolidado da oportunidade é um único campo (`value`), informado manualmente no fluxo atual.

### 1.5 Cultura e safra

`crop` e `season` já existem no modelo e nos formulários atuais de criação/edição.

### 1.6 Etapa e status ganho/perdido

A etapa (`stage`) segue funil único:

- `prospeccao`
- `negociacao`
- `proposta`
- `ganho`
- `perdido`

O fechamento é representado pela própria etapa (ganho/perdido) e também por `closedAt`.

### 1.7 Onde anexar produtos (melhor ponto técnico)

**Recomendação**: anexar produtos em uma entidade filha da oportunidade (ex.: `OpportunityItem`) em relação 1:N.

Motivos:

- evita sobrecarga/ambiguidade do campo textual `productOffered`;
- permite cálculo auditável de valor por item e total;
- facilita validação por código ERP de produto;
- prepara serialização para pedido ERP sem “parsing” de texto livre.

`productOffered` pode permanecer temporariamente como campo legado/descritivo durante transição.

---

## 2) Proposta de modelo futuro (conceitual)

## 2.1 Nova entidade: `OpportunityItem`

Campos propostos:

- `id`
- `opportunityId`
- `lineNumber` (ordem do item)
- `erpProductCode` (obrigatório para integração)
- `productNameSnapshot` (nome no momento da negociação)
- `quantity`
- `unit` (ex.: KG, SC, UN)
- `unitPrice`
- `discountType` (`percent` | `value`)
- `discountValue`
- `grossTotal`
- `netTotal`
- `crop` (opcional, herda da oportunidade por padrão)
- `season` (opcional, herda da oportunidade por padrão)
- `technicalNotes`
- `createdAt`
- `updatedAt`

## 2.2 Regra de cálculo sugerida

- `grossTotal = quantity * unitPrice`
- desconto percentual: `discountAmount = grossTotal * (discountValue/100)`
- desconto em valor: `discountAmount = discountValue`
- `netTotal = grossTotal - discountAmount`
- valor total da oportunidade = soma dos `netTotal` dos itens.

## 2.3 Estratégia de compatibilidade

- manter `Opportunity.value` como valor consolidado do negócio;
- após inclusão de itens, `value` passa a ser calculado (ou ao menos validado) pela soma dos itens;
- preservar `productOffered` em modo legado para histórico/relatórios até migração completa.

---

## 3) Dados necessários do ERP Ultra / FV3 para criar pedido

Abaixo, o pacote mínimo de dados de referência que o CRM precisa consumir/sincronizar.

## 3.1 Cadastros/tabelas de origem

1. **Produtos**
   - código ERP do produto
   - descrição
   - unidade comercial
   - status (ativo/inativo)
   - tabela de preço/custo (se aplicável)

2. **Clientes**
   - código ERP
   - CNPJ/CPF
   - razão social/nome fantasia
   - situação cadastral
   - regras comerciais/bloqueios (se houver)

3. **Vendedores**
   - código ERP do vendedor
   - nome
   - vínculo de equipe/região (se aplicável)

4. **Condição de pagamento**
   - código ERP
   - descrição
   - parcelas/prazos

5. **Forma de pagamento**
   - código ERP
   - descrição

6. **Pedidos (cabeçalho)**
   - identificador ERP
   - cliente, vendedor, condição/forma de pagamento
   - datas e observações

7. **Itens de pedido**
   - número do pedido
   - linha
   - produto
   - quantidade
   - unidade
   - preço
   - descontos
   - total

## 3.2 Campos obrigatórios para criar pedido (mínimo esperado)

No CRM, para serializar pedido futuro, considerar obrigatórios:

- cliente (`erpClientCode` ou fallback validado por CNPJ);
- vendedor (`erpSellerCode`);
- ao menos 1 item com `erpProductCode`, quantidade, unidade e preço;
- condição de pagamento (`erpPaymentTermCode`);
- forma de pagamento (`erpPaymentMethodCode`);
- data de entrega prevista;
- totais do pedido coerentes com itens.

> Observação: o mapeamento final depende do layout/API oficial do Ultra/FV3 (a confirmar com documentação técnica do fornecedor).

---

## 4) Fluxo comercial desejado (to-be)

## 4.1 Pipeline operacional

1. oportunidade em **negociação/proposta**;
2. usuário adiciona produtos na grade de itens;
3. CRM recalcula total automaticamente;
4. usuário marca oportunidade como **ganha**;
5. sistema habilita ação **“Gerar pedido”**;
6. usuário informa:
   - condição de pagamento
   - forma de pagamento
   - data de entrega
   - observações comerciais/técnicas
7. CRM gera **pré-pedido** (estado pendente de envio) e, depois, envia ao ERP.

## 4.2 Estados recomendados para pedido no CRM

- `draft` (rascunho)
- `ready_to_send` (pronto)
- `sent` (enviado ao ERP)
- `integrated` (confirmado no ERP)
- `error` (falha de integração)

Isso permite rastreabilidade e reprocessamento sem duplicar pedido.

---

## 5) Riscos e controles técnicos

## 5.1 Não gravar direto no banco do ERP

- integração deve ocorrer por API/serviço oficial;
- sem escrita direta em tabela do ERP sem validação de contrato e transação.

## 5.2 Evitar duplicidade de pedido

- usar chave de idempotência por oportunidade + versão dos itens;
- gravar `externalRequestId` no pedido local;
- bloquear reenvio cego enquanto status estiver `sent`/`integrated`.

## 5.3 Validações de consistência (antes de enviar)

- cliente por `erpClientCode` e/ou CNPJ;
- produto por `erpProductCode` (ativo);
- condição de pagamento por código ERP;
- forma de pagamento por código ERP;
- vendedor com código ERP válido.

## 5.4 Log e auditoria de integração

Registrar:

- payload enviado (sanitizado);
- resposta do ERP;
- status final;
- timestamp;
- usuário que acionou;
- tentativas/retries.

Recomenda-se uma trilha por pedido e também evento na timeline da oportunidade.

---

## 6) Plano incremental sugerido (sem implementação nesta PR)

## Fase 0 — diagnóstico (esta PR)

- mapear estado atual e desenho alvo.

## Fase 1 — modelagem interna

- criar estrutura de itens de oportunidade e regras de cálculo.

## Fase 2 — UX comercial

- adicionar grade de itens na oportunidade;
- atualizar total automático;
- habilitar modal de geração de pedido.

## Fase 3 — pedidos locais

- criar entidade de pré-pedido/pedido no CRM com estados e idempotência.

## Fase 4 — integração ERP

- consumir cadastros ERP (produto/cliente/vendedor/condições/formas);
- enviar pedido por conector oficial;
- receber retorno e reconciliar status.

---

## 7) Gap técnico atual vs alvo

## Hoje

- oportunidade possui apenas campo textual `productOffered` e valor consolidado manual (`value`);
- não há entidade de item de oportunidade;
- não há entidade de pedido no CRM;
- não há integração implementada para criação de pedido no ERP Ultra/FV3.

## Alvo

- oportunidade com múltiplos itens estruturados;
- total calculado por item;
- geração de pré-pedido/pedido com validação de códigos ERP;
- rastreabilidade completa de envio e retorno de integração.

---

## 8) Checklist de preparação técnica para próxima PR

- [ ] definir contrato de dados oficial Ultra/FV3 (campos, tipos, regras);
- [ ] definir estratégia de sincronização de cadastros ERP;
- [ ] detalhar validações de negócio por item/cabeçalho;
- [ ] especificar política de idempotência e retries;
- [ ] definir observabilidade (logs, métricas, alertas);
- [ ] desenhar migração gradual do `productOffered` legado.

