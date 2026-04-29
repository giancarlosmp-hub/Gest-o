# Mapa técnico de integração real com ERP Ultra Sistemas / Ultra FV3

## Status desta investigação

> **Resultado:** no snapshot atual do repositório **não foi possível localizar** os artefatos necessários para mapear tecnicamente a integração real (UltraFV3, UltraFv3Rest, `.aws.env`, `Gestao.FDB`, logs e scripts específicos do Ultra FV3).

Esta PR cumpre o escopo de **investigação + documentação** sem qualquer escrita em banco ou alteração funcional.

---

## 1) Inspeção dos arquivos da pasta UltraFV3

### Escopo solicitado
- `config`
- `.aws.env`
- `dist/`
- `logs/`
- `UltraFv3Rest`
- scripts existentes

### Achado objetivo
Não existe, neste workspace (`/workspace/Gest-o`), nenhuma pasta/arquivo localizado com nomes:
- `UltraFV3`
- `UltraFv3Rest`
- `.aws.env`
- `Gestao.FDB`
- qualquer diretório/arquivo contendo `ultra`, `fv3` ou `.fdb`.

### Comandos executados (somente leitura)
```bash
pwd && rg --files -g 'AGENTS.md'
find /workspace -maxdepth 5 -type d | rg -i 'UltraFV3|UltraFv3Rest|Gestao\.FDB|firebird|ultra'
cd /workspace/Gest-o && find . -maxdepth 6 \( -iname '*ultra*' -o -iname '*fv3*' -o -iname '*.fdb' -o -iname '.aws.env' \) -print
```

---

## 2) Mapeamento de endpoints HTTP/REST do UltraFv3Rest

### Objetivo solicitado
Mapear:
- porta
- rotas
- autenticação
- payloads
- endpoints (clientes, produtos, vendedores, pedidos, condições/formas de pagamento, sincronização)

### Achado objetivo
**Bloqueado por ausência de artefato executável/configurável** do serviço `UltraFv3Rest` neste repositório.

Sem binário, código-fonte, OpenAPI/Swagger, logs do serviço ou arquivo de configuração, não há base técnica verificável para inferir portas/rotas/autenticação com segurança.

---

## 3) Investigação do Firebird `Gestao.FDB` (somente leitura)

### Objetivo solicitado
Listar tabelas relacionadas a:
- clientes/parceiros
- produtos
- vendedores/usuários
- pedidos
- itens
- condição/forma de pagamento
- status
- filial/empresa/operação fiscal

### Achado objetivo
**Bloqueado por duas razões simultâneas:**
1. arquivo `Gestao.FDB` não foi encontrado no workspace;
2. cliente Firebird (`isql-fb`/`isql`) não está instalado no ambiente.

### Comandos tentados
```bash
cd /workspace/Gest-o && command -v isql-fb || command -v isql || echo 'no-firebird-cli'
cd /workspace/Gest-o && find . -maxdepth 6 \( -iname '*.fdb' -o -iname '*gestao*' -o -iname '*firebird*' \) -print
```

Saída relevante: `no-firebird-cli`.

---

## 4) Campos necessários para pré-pedido válido no CRM (mapeamento preliminar)

Como não foi possível validar o esquema real do ERP/UltraFV3, este item é um **draft funcional mínimo** (a confirmar na homologação técnica):

### Cabeçalho do pedido (mínimo esperado)
- `cliente_codigo_erp` (obrigatório)
- `vendedor_codigo_erp` (obrigatório)
- `vendedor_cpf` (recomendado para rastreabilidade do login FV3)
- `condicao_pagamento_codigo` (obrigatório)
- `forma_pagamento_codigo` (obrigatório em ERPs que separam condição x forma)
- `filial_codigo` / `empresa_codigo` (obrigatório quando multi-filial)
- `operacao_fiscal_codigo` / `tipo_operacao` (geralmente obrigatório em faturamento)
- `data_emissao` (normalmente obrigatório)
- `data_entrega` (obrigatório dependendo da política comercial)
- `observacao` (opcional)
- `situacao_inicial_pedido` (ex.: pré-pedido/aberto/pendente)

### Itens do pedido (mínimo esperado)
- `produto_codigo_erp` (obrigatório)
- `quantidade` (obrigatório)
- `unidade` (obrigatório quando ERP controla conversão)
- `preco_unitario` (obrigatório)
- `desconto_valor` ou `desconto_percentual` (conforme regra do ERP)
- `sequencia_item` (frequente)

> **Importante:** estes campos precisam ser confirmados contra o modelo real de tabelas e/ou contrato de API do UltraFv3Rest.

---

## 5) Formas seguras de integração (análise de viabilidade)

### a) Via UltraFv3Rest
- **Recomendação primária**, desde que o serviço exista e tenha contrato estável.
- Vantagens: validação de regras de negócio no próprio ecossistema Ultra; menor risco de corrupção transacional em relação a escrita direta no Firebird.
- Dependências: acesso ao endpoint real, documentação de autenticação e payloads, ambiente de homologação.

### b) Via arquivo de importação
- Pode ser alternativa se o ERP/UltraFV3 já suportar lote de pré-pedidos.
- Exige layout formal (campos, tamanhos, encoding, validações) e trilha de retorno de erros.

### c) Via endpoint cloud/AWS
- Não verificável nesta investigação por ausência de `.aws.env` e artefatos de deploy/config.
- Requer inventário de infraestrutura e política de segurança.

### d) Leitura direta do Firebird
- Aceitável para consulta (catálogo/sincronização) em modo somente leitura.
- **Não recomendado para escrita** sem homologação oficial do fornecedor/consultoria do ERP.

---

## 6) Riscos de integração identificados

1. **Risco de engenharia reversa incompleta**: sem acesso ao UltraFv3Rest real, qualquer payload/rota inferido pode estar errado.
2. **Risco transacional/fiscal**: escrita direta em Firebird sem camada de negócio pode violar regras fiscais/comerciais.
3. **Risco de autenticação**: fluxo de login por CPF/senha no app FV3 precisa validação formal (token, sessão, expiração).
4. **Risco de dados mestres inconsistentes**: cliente/produto/vendedor/filial sem chave ERP confiável inviabiliza pedido válido.
5. **Risco de compliance e segurança**: exposição de credenciais em config/logs se não houver mascaramento e segregação de ambientes.

---

## Recomendação técnica final

Com base no que foi possível verificar no repositório atual:

1. **Priorizar integração via UltraFv3Rest** (quando o artefato e contrato técnico estiverem acessíveis).
2. **Criar conector próprio somente leitura** para sincronização de cadastro (clientes/produtos/vendedores) enquanto a escrita não estiver homologada.
3. **Nunca escrever diretamente no banco Firebird de produção sem homologação formal** do responsável pelo ERP e plano de rollback.

---

## Plano de PRs futuras (proposto)

### PR 1 — Catálogo de produtos no CRM
- sincronização somente leitura
- tabela/cache local de produtos com `codigo_erp`
- rotina incremental e monitoramento

### PR 2 — Itens de oportunidade
- modelagem de itens na oportunidade
- vínculo com produto ERP
- cálculo de preço/desconto no CRM

### PR 3 — Pré-pedido interno
- geração de estrutura interna de pré-pedido
- validações de campos obrigatórios
- status internos de preparação/envio

### PR 4 — Integração UltraFv3Rest
- conector HTTP autenticado
- mapeamento de payload para pedido
- tratamento de erros e idempotência

### PR 5 — Retorno/status do pedido ERP
- sincronização de status
- trilha de auditoria
- reconciliação CRM x ERP

---

## Pendências para próxima investigação (insumos mínimos)

Para avançar em mapeamento real, é necessário disponibilizar (em ambiente seguro):
- pasta `UltraFV3` com `config`, `dist`, `logs`, scripts e serviço `UltraFv3Rest`;
- documentação/contrato de API (Swagger/OpenAPI/Postman), se existir;
- acesso somente leitura ao Firebird (`Gestao.FDB`) + cliente SQL (`isql-fb`) ou dump de schema;
- exemplos anonimizados de pedidos válidos já emitidos no ERP.
