# Plano de enforcement dual-parent de Activity

**Estado:** prova técnica 1.0B.2-F; DDL não autorizado para produção. `TENANCY_MODE=disabled`.

## Schema observado e semântica

No schema Prisma, `Client.id` e `Opportunity.id` são PKs `text`; `Opportunity.clientId` é obrigatório; `Activity.clientId` e `Activity.opportunityId` são opcionais. As FKs simples atuais apontam para as PKs e usam, no predecessor, `SET NULL/CASCADE` em Activity e `RESTRICT/CASCADE` entre Opportunity e Client. Há índices simples de Activity sobre cada FK e de Client sobre `tenantId`. `Client.tenantId` continua nullable. A política produtiva do repository continua XOR e não aceita dual-parent; este plano não está ligado ao Prisma Client nem às rotas.

## Estratégias comparadas

| Estratégia | Atomicidade/concorrência | Vantagens | Riscos/custo |
|---|---|---|---|
| Unique `(Opportunity.id, clientId)` + FK `(Activity.opportunityId, clientId)` | Garantida pelo PostgreSQL em toda escrita | Declarativa, catalogável, protege qualquer writer e usa `MATCH SIMPLE` para um só pai | índice adicional; lock de DDL; `NOT VALID` preserva conflitos antigos, mas exige saneamento antes de validar |
| Constraint trigger | Pode ser correta com locks explícitos | mensagens/regras flexíveis | código procedural, ordem/lock e deadlocks mais difíceis; maior superfície operacional |
| Query transacional | Não basta sem locks serializáveis/predicados | nenhuma DDL | bypass por outro writer e janela TOCTOU; não é garantia do banco |
| Ownership materializado em Activity | Pode usar FKs tenant-first | consultas diretas | nova fonte duplicada, backfill e sincronização; não resolve sozinha a identidade dos Clients |

**Recomendação futura:** a FK composta, depois de diagnóstico e remediação aprovados. `id` já é globalmente único, portanto o unique composto é redundante para identidade, mas é a chave referenciada necessária e deixa a regra explícita. PostgreSQL 16 permite FK para índice unique não parcial.

## DDL candidato e NULL

O artefato executável de prova é `scripts/smoke/sql/activity-dual-parent-candidate.sql`. Ele cria o unique e a FK `NOT VALID`, com `ON DELETE SET NULL` e `ON UPDATE RESTRICT`. `MATCH SIMPLE` é intencional: se qualquer componente for NULL, a FK composta não é verificada. Assim somente Client, somente Opportunity e ambos NULL continuam permitidos; as FKs simples ainda negam IDs inexistentes. Um dual-parent só é aceito quando ambos identificam a mesma Opportunity/Client. A cadeia Opportunity → Client → Tenant rejeita indiretamente um par de Clients de tenants diferentes, mas pai com `tenantId NULL` continua possível nesta fase expand.

## Diagnóstico histórico (somente leitura; não executado em produção)

```sql
SELECT count(*) FILTER (WHERE a."clientId" IS NOT NULL AND a."opportunityId" IS NOT NULL AND a."clientId" = o."clientId") AS dual_convergente,
       count(*) FILTER (WHERE a."clientId" IS NOT NULL AND a."opportunityId" IS NOT NULL AND a."clientId" <> o."clientId") AS dual_divergente,
       count(*) FILTER (WHERE a."clientId" IS NULL AND a."opportunityId" IS NULL) AS sem_pais,
       count(*) FILTER (WHERE a."clientId" IS NOT NULL AND a."opportunityId" IS NULL) AS somente_client,
       count(*) FILTER (WHERE a."clientId" IS NULL AND a."opportunityId" IS NOT NULL) AS somente_opportunity
FROM public."Activity" a LEFT JOIN public."Opportunity" o ON o.id=a."opportunityId";

SELECT count(*) FILTER (WHERE a."clientId" IS NOT NULL AND c.id IS NULL) AS client_inexistente,
       count(*) FILTER (WHERE a."opportunityId" IS NOT NULL AND o.id IS NULL) AS opportunity_inexistente
FROM public."Activity" a LEFT JOIN public."Client" c ON c.id=a."clientId"
LEFT JOIN public."Opportunity" o ON o.id=a."opportunityId";

SELECT count(*) FILTER (WHERE (c.id IS NOT NULL AND c."tenantId" IS NULL) OR (oc.id IS NOT NULL AND oc."tenantId" IS NULL)) AS pai_tenant_null,
       count(*) FILTER (WHERE c."tenantId" IS DISTINCT FROM oc."tenantId" AND c."tenantId" IS NOT NULL AND oc."tenantId" IS NOT NULL) AS cross_tenant
FROM public."Activity" a LEFT JOIN public."Client" c ON c.id=a."clientId"
LEFT JOIN public."Opportunity" o ON o.id=a."opportunityId"
LEFT JOIN public."Client" oc ON oc.id=o."clientId";
```

Nenhum count acima representa produção. “Órfã” deve ser distinguida entre linha sem links (permitida) e link para ID inexistente (negado pelas FKs simples).

## Rollout, locks e rollback futuro

1. Executar diagnósticos read-only e aprovar tratamento de divergências; não apagar silenciosamente.
2. Criar o unique com `CREATE UNIQUE INDEX CONCURRENTLY` no procedimento operacional (fora de transação) se volume/medição exigirem; o DDL compacto do harness não modela disponibilidade.
3. Adicionar FK `NOT VALID` com `lock_timeout` aprovado: ainda requer lock e pode bloquear writers brevemente. Monitorar locks, WAL e replicação.
4. Validar separadamente após mismatch zero; atualizar Prisma com `@@unique([id, clientId])` e relação composta, regenerar Client e provar create/update/delete.
5. Só em Sprint posterior alterar a política XOR/runtime.

Rollback é `ALTER TABLE ... DROP CONSTRAINT` seguido de `DROP INDEX`; é DDL transacional, demonstrada com `ROLLBACK` no harness. Depois de writes dual-parent, rollback do banco não implica rollback seguro do runtime. `ON DELETE SET NULL` na FK composta zera ambas as colunas; a interação com FKs simples e ações referenciais deve ser revalidada na migration final.

## Impacto Prisma e limites

A migration futura exigirá unique composto em Opportunity e relação composta em Activity; a relação simples de `opportunityId` precisará desenho cuidadoso para evitar duas relações concorrentes. Fixtures pequenas não medem lock/tempo/WAL produtivos, não validam dados reais, não executam backfill e não provam Client gerado. `NOT VALID` fiscaliza writes novos e updates, mas preserva linhas históricas divergentes até remediação e `VALIDATE CONSTRAINT`.
