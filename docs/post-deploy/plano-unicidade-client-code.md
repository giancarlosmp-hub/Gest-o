# Plano futuro de unicidade de `Client.code`

## Decisão atual

**Não aplicar UNIQUE nesta PR.** `code` é anulável, dados legados e rotinas de merge usam códigos sufixados, e não há inventário sanitizado de produção que prove ausência de repetidos. O sync consulta todos os candidatos pelo código e também resolve pelo documento completo; impor unicidade agora pode converter ambiguidade observável em indisponibilidade. Importação/API evitam duplicidade ativa na aplicação, mas não protegem escritores externos nem eliminam legados arquivados.

UNIQUE composta com vendedor é inadequada: troca de carteira deve preservar o cliente. UNIQUE global é o destino mais claro somente se o UltraFV3 confirmar código global. Se códigos forem reutilizados entre tenants/filiais, o destino deve ser composto por uma chave de origem ainda inexistente. UNIQUE parcial para ativos tolera legado, mas pode bloquear reativação e não garante identidade histórica.

## Vantagens, desvantagens e impactos

Vantagens: proteção concorrente no banco, idempotência mais forte e investigação simples. Desvantagens: falha de lote diante de legado, possível bloqueio de reativação/troca legítima e incompatibilidade se o domínio não for global. O risco ERP é alto sem contrato e profiling: `P2002` pode interromper persistência e deixar finanças/títulos defasados.

## Migração proposta (não executada)

1. Confirmar domínio do código (global, empresa, filial ou tenant), reutilização e mudanças.
2. Medir por 30 dias duplicados ativos/arquivados, documentos divergentes e escritores; exportar apenas IDs/hash.
3. Classificar colisões e sanear com dry-run, aprovação, backup e auditoria.
4. Introduzir `erpSourceId`/`tenantId` se o domínio exigir.
5. Ensaiar índice UNIQUE candidato em homologação, incluindo sync, importador, reativação, finanças e rollback.
6. Validar zero colisões em produção, criar índice sem bloqueio, monitorar `P2002` e manter rollback.
7. Alinhar validações da API ao contrato do banco.

Só aprovar a constraint com contrato escrito, zero colisões incompatíveis em dois snapshots, cobertura de concorrência e aceite de ERP/Financeiro. Até lá, manter índice não único.
