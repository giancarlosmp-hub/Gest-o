# Incidente 2026-07-17: reconciliação antes de recuperar pais órfãos

Este documento substitui qualquer orientação operacional anterior de criar pais genéricos imediatamente.
A recuperação de `Client` e `Product` órfãos deve ser conduzida em duas fases:

1. **reconciliação sem alteração de dados**, para encontrar pais atuais por chaves estáveis;
2. **correção reversível**, somente depois de classificar cada órfão.

## Regras confirmadas no código

### Clientes UltraFV3

A sincronização de parceiros identifica clientes por chaves estáveis, não pelo `Client.id` do CRM:

- código ERP do parceiro (`code`);
- documento/CNPJ normalizado (`cnpjNormalized` ou `cnpj`);
- fallback por identidade normalizada (`nameNormalized`, `cityNormalized`, `state`) quando código e documento não encontram candidatos.

Quando há múltiplos candidatos, o código escolhe um primário priorizando não arquivados, maior volume de histórico, vendedor dono, atualização ERP mais recente e criação mais antiga. Duplicados não são apagados: o histórico é movido para o primário e o duplicado é arquivado com `archiveReason=MERGED_INTO:<primaryId>`.

Quando o ERP indica outro vendedor, o `ownerSellerId` do `Client` pode mudar, mas o código registra evento de auditoria e declara que oportunidades, atividades, autores e datas históricas são preservados. Portanto a reconciliação não deve alterar `Opportunity.ownerSellerId`, autores de histórico, nem ownership de registros filhos sem validação de domínio.

### Produtos UltraFV3

Produtos são identificados por `(erpProductCode, erpProductClassCode)`. A sincronização faz `upsert` nessa chave e não depende do `Product.id` para reconhecer o produto atual.

A busca para seleção em oportunidades oculta produtos quando qualquer uma das condições abaixo ocorre:

- `isActive=false` ou `isSuspended=true`;
- produto não sincronizado (`rawErpPayload` ausente/vazio);
- preço inválido para a tabela selecionada (`price <= 0` ou sem match de tabela).

Assim, produtos recuperados como último recurso devem ficar `isActive=false`, `isSuspended=true`, com preço zero/sem preço válido, para não aparecerem na seleção de produtos.

## Classificação obrigatória

Cada `orphan_id` deve ser classificado antes de qualquer `UPDATE`/`INSERT`:

| Classe | Critério | Ação |
| --- | --- | --- |
| 1. Correspondência exata e segura | Código ERP/documento/chave composta aponta para um único pai atual consistente | Atualizar FKs para o `current_id` atual, sem alterar ownership/histórico |
| 2. Correspondência provável | Nome normalizado, payload ou evidência indireta encontra candidato, mas não é único/forte | Não alterar sem revisão humana |
| 3. Sem correspondência | Nenhuma chave estável encontra pai atual | Criar pai arquivado/inativo somente como último recurso, nunca ativo |

## Artefato SQL

Use `scripts/recovery/reconcile-20260717-orphans.sql` no banco limpo para criar tabelas temporárias de reconciliação e emitir relatórios. O script não altera tabelas de negócio.
