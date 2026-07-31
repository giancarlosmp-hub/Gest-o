# Guia operacional pós-deploy — identidade UltraFV3

## Objetivo e janela

Use este checklist diariamente nos primeiros 7 dias e semanalmente até completar 30 dias. A regra de matching não foi alterada nesta entrega. Registre período UTC, ambiente, responsável, `ErpSyncRun.id`/`correlationId`, resultado e link do incidente.

## Checklist

- [ ] Validar por amostra que parceiros com a mesma razão social e CNPJs completos diferentes geraram clientes distintos.
- [ ] Verificar que não houve redução inesperada na criação de clientes.
- [ ] Revisar `rejected_document_conflict`; não corrigir conflitos automaticamente.
- [ ] Revisar clientes criados por fallback sem documento (`identity_fallback_no_document`).
- [ ] Consultar `ClientCodeAudit`, correlacionando toda alteração de `Client.code` por `requestId`.
- [ ] Verificar integrações financeiras e conciliar valores com o ERP.
- [ ] Validar vínculo, atualidade e consistência de `financialProfile` após mudança legítima de código.
- [ ] Validar vínculo e atualização de `partnerTitles`, inclusive títulos abertos/vencidos.
- [ ] Comparar clientes criados nos 14 dias antes e depois, controlando volume de payload e vendedores sincronizados.
- [ ] Confirmar que mudança legítima de código ERP é reconciliada pelo documento completo (`document_exact`) no mesmo `Client.id`.

## Guardrails

CPF/CNPJ nunca deve aparecer completo em ticket, dashboard ou log: use presença, máscara ou hash. Pare o sync e escale quando houver crescimento abrupto de conflitos, alteração de código sem auditoria, dois documentos completos no mesmo cliente, ou divergência entre `Client.code`, `financialProfile` e `partnerTitles`. Preserve evidências antes de reparar; correções exigem dry-run, backup validado e rollback.
