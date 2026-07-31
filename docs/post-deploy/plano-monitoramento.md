# Plano de monitoramento da identidade de parceiros

## Arquitetura

Cada decisão de `resolvePartnerIdentityMatch()` incrementa no diagnóstico persistido de `ErpSyncRun.metrics` um contador: `code_exact`, `document_exact`, `identity_fallback_no_document`, `rejected_document_conflict`, `create_no_safe_match` ou `ambiguous_identity_no_document`. A execução agrega `created`, `updated`, `updatedByCode`, `updatedByDocument` e `documentErpConflicts`. Logs JSON contêm `correlationId`, estratégia, presença de documento e quantidade/IDs técnicos de candidatos, nunca CPF/CNPJ.

`ClientCodeAudit` é a trilha permanente e transacional: grava instante no banco, ator quando autenticado, origem controlada, valores anterior/novo, cliente, parceiro ERP, IP e `requestId`. A escrita ocorre na mesma transação da criação/alteração coberta. Eventos sem mudança normalizada não geram ruído.

## Painéis e alertas

Construir painéis por hora/dia a partir de `ErpSyncRun.metrics`. Alertas iniciais, a calibrar após 14 dias:

| Sinal | Alerta | Ação |
|---|---:|---|
| `rejected_document_conflict` | qualquer evento | triagem no mesmo dia |
| `identity_fallback_no_document` | > 2x mediana de 7 dias | validar qualidade do ERP |
| `created / received` | queda > 40% | validar paginação, credenciais e matching |
| auditoria sem request operacional | qualquer evento | incidente de observabilidade |
| `updatedByDocument` | zero com mudanças conhecidas | conferir reconciliação |

Retenção recomendada: auditoria conforme prazo legal/contratual (mínimo operacional sugerido: 24 meses), logs online 30 dias e arquivados 180 dias. A tabela é append-only por política: a aplicação não oferece update/delete; permissões de banco devem reforçar a garantia.

## Perguntas respondidas

- Clientes criados: `created`.
- Conflitos documentais: `documentErpConflicts` e estratégias rejeitadas.
- Fallbacks textuais: `identity_fallback_no_document`.
- Updates por documento/código: `updatedByDocument`/`updatedByCode`.
- Mudanças de código: `ClientCodeAudit`, por período, cliente, origem ou request.
