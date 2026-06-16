# Validação de Produção — UltraFV3 CRM

Execute este checklist após aplicar a migration e realizar o deploy.

## 1. Saneamento legado obrigatório

```bash
npm run erp:fix-duplicates
```

Registrar do log final:

- `groupsFound`: grupos candidatos encontrados.
- `groupsChanged`: grupos saneados.
- `conflictsFound`: grupos ignorados por conflito de identidades fortes.
- `relationshipsMoved`: relacionamentos migrados ao cliente principal.
- `duplicatesArchived`: registros arquivados internamente.
- `visibleAfterCleanup`: contagens visíveis para LAIZE, ERP 3950, EMR e prefixo `[ARQUIVADO ERP DUP]`.

Se `conflictsFound > 0`, revisar os IDs emitidos no log antes de nova execução.

## 2. Casos reais Demetra

### ERP 3950 — LAIZE DE SOUZA AGROPECUARIA

Esperado:

- apenas um cliente visível;
- vendedor atual: Jefferson Luiz Carlota;
- nenhuma ocorrência `[ARQUIVADO ERP DUP]` nas pesquisas;
- linha do tempo preservada;
- oportunidades preservadas.

### ERP 6861 — EMPREENDIMENTOS EMR LTDA

Esperado:

- apenas um cliente visível;
- sem duplicidade;
- sem cliente arquivado aparecendo em busca;
- histórico preservado.

## 3. Regressão de carteira

Ao sincronizar `/partners` após troca de vendedor no UltraFV3:

- não criar novo cliente;
- não criar arquivado visível;
- atualizar somente o vendedor/carteira atual do cliente;
- manter autores, movimentações, encerramentos e datas históricas de oportunidades, atividades e timeline.

## 4. Vendedor baixado no UltraFV3

Após `DATA_BAIXA` em `/salesmen`:

- usuário CRM fica `isActive=false`;
- login retorna usuário inativo;
- oportunidades, clientes, atividades e timeline permanecem preservados.

## 5. Dados financeiros

Validar em cliente com movimentação real:

- Perfil Financeiro ERP: ticket médio, primeira compra, última compra, média de atraso, cheques devolvidos e badge de risco;
- Títulos em Aberto: documento, parcela, vencimento, forma, valor, saldo, total aberto e total vencido;
- Nova oportunidade: alerta de títulos vencidos aparece sem bloquear criação.
