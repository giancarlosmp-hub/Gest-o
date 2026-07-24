# PR 18A.4 — Auditoria de integridade pós-recuperação e ERP Code 5050

## Escopo e regra de segurança

Esta investigação é **read-only por padrão**. A PR não cria cliente automaticamente, não faz merge automático, não apaga registros e não altera dados de produção antes de um dry-run revisado e autorizado.

## Evidência operacional incorporada

- O parceiro ERP Code `5050` foi movido no ERP de Izabela para Edirlei.
- A sincronização manual por todos os vendedores indicou aumento de 1 no contador de Edirlei.
- A tela Clientes com filtro de Edirlei exibiu aproximadamente 1894 clientes e o 5050 não foi localizado visualmente.

Hipótese principal: o ERP pode ter retornado o 5050 e o sync pode ter processado o registro; a divergência pode estar em owner, arquivamento, duplicidade, consulta `GET /clients`, busca/paginação da UI ou legado de recuperação.

## Entregáveis implementados nesta PR

- `npm run crm:audit-erp-client -- --erp-code=5050`: comando read-only com saída sanitizada para localizar registros por ERP code, documentos/nome derivados e prefixos de recuperação.
- `npm run crm:repair-erp-client -- --erp-code=5050 --dry-run`: comando de plano de reparo sem mutação. O modo `--apply` permanece bloqueado nesta PR até autorização explícita após o dry-run.

## Critérios auditados

### Classificação de achados

- `CRITICAL`: múltiplos registros ativos com o mesmo ERP Code ou relacionamento órfão crítico.
- `DATA_INCONSISTENCY`: registro ativo/arquivado conflitante, owner divergente, código ERP ausente em registro recuperado provável, documento duplicado.
- `LEGACY_ACCEPTED`: registro arquivado com prefixo histórico preservado e sem impacto no `GET /clients` padrão.
- `SAFE_TO_REPAIR`: um único alvo inequívoco, backup lógico possível, relações preserváveis e ação idempotente.
- `MANUAL_REVIEW_REQUIRED`: qualquer ambiguidade por documento/nome, múltiplos candidatos ativos, campos legados sem prova suficiente ou histórico de recuperação incompleto.

### Consulta `GET /clients`

O endpoint padrão exclui `isArchived=true`, aplica restrição de vendedor por permissão e aceita filtros de `ownerSellerId`/`vendedorId` para perfis não vendedores. Busca textual cobre nome, fantasia, código ERP, documento, cidade, UF, região e segmento.

### Significado do contador de sync

No fluxo UltraFV3 por vendedor, o contador retornado como `syncedCount` representa linhas do ERP que foram normalizadas e persistidas como criação ou atualização. Ele não é equivalente ao total visível em `GET /clients`, porque pode incluir atualizações de registros arquivados, registros fora da página atual, registros depois excluídos por filtros e diferença entre “processado/sincronizado” e “visível”. A UI não deve rotular esse valor como total de clientes visíveis.

## Plano de reparo idempotente proposto

1. **Dry-run**: executar `npm run crm:repair-erp-client -- --erp-code=5050 --dry-run` e anexar o JSON ao incidente.
2. **Backup lógico**: antes de qualquer `--apply`, exportar campos afetados do(s) cliente(s) e IDs de relações (`Opportunity`, `Activity`, `AgendaEvent`, `AgendaStop`, `Contact`, `ErpOrderSync`).
3. **Relatório antes**: salvar a saída completa de auditoria read-only.
4. **Repair**: aplicar somente uma ação inequívoca e transacional; abortar em ambiguidade.
5. **Relatório depois**: repetir auditoria e comparar contagens/IDs.
6. **Rollback lógico**: restaurar campos do backup lógico em transação se a validação falhar.

Ações permitidas somente se comprovadas: mover código ERP para o registro ativo correto, atualizar owner, arquivar duplicado legado, relink de relações órfãs, restaurar ERP Code perdido ou corrigir `isArchived` incorreto. Ações proibidas: delete físico, merge por nome apenas, sobrescrever histórico ou alterar múltiplos clientes ambíguos.

## Estado operacional que ainda depende do ambiente de produção

A prova de commit em produção, divergência Preview x produção, cooling 404, Agenda 403, health/version autenticado e scheduler automático UltraFV3 exigem execução contra a VPS/container real. Esta PR entrega comandos e documentação; sem credenciais/saída de produção, a decisão operacional deve permanecer `MANTER EM INVESTIGAÇÃO` ou `DEPLOY_DIVERGENTE` se o health/version provar código antigo.
