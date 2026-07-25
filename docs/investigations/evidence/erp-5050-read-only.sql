-- ============================================================================
-- ERP 5050 FORENSIC ANALYSIS
--
-- ESTE SCRIPT É EXCLUSIVAMENTE READ-ONLY.
--
-- É PROIBIDO adicionar UPDATE, INSERT, DELETE, TRUNCATE, ALTER, DROP ou
-- qualquer comando de escrita neste arquivo.
--
-- Execute com uma role que tenha apenas CONNECT/USAGE/SELECT. O bloco abaixo
-- também impede escrita acidental na sessão e configura limites de espera.
-- Cada consulta devolve agregados ou identificadores técnicos; não exporte
-- name/cnpj para o artefato da investigação.
--
-- Definição repetida de "população 5050": o código atual é 5050 (zeros à
-- esquerda ignorados) OU o código preserva 5050 antes dos marcadores usados na
-- neutralização (__MERGED__ / __LEGACY_DUP__). Esta definição deve ser validada
-- pela consulta 0 antes de interpretar os demais resultados.
--
-- Ao final, a transação é encerrada com COMMIT sem qualquer mutação.
-- ============================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- 0a. Guard rail: confirmar banco, role, modo read-only e fuso da sessão.
SELECT current_database() AS database_name,
       current_user AS database_role,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('TimeZone') AS session_timezone,
       statement_timestamp() AS collected_at;

-- 0b. Confirmar as colunas realmente disponíveis. No schema versionado Client
-- não possui updatedAt; não tente consultar uma coluna ausente.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'Client'
  AND column_name IN ('code', 'isArchived', 'archiveReason', 'createdAt',
                      'updatedAt', 'erpUpdatedAt', 'ownerSellerId', 'cnpj',
                      'cnpjNormalized', 'name')
ORDER BY column_name;

-- 1. Total relacionado ao código ERP 5050, separado por estado.
WITH population AS (
  SELECT c.*
  FROM "Client" c
  WHERE regexp_replace(
          split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1),
          '^0+', ''
        ) = '5050'
)
SELECT CASE WHEN "isArchived" THEN 'archived' ELSE 'active' END AS state,
       count(*) AS client_count
FROM population
GROUP BY 1
ORDER BY 1;

-- 2. Arquivados por motivo (NULL é mantido como categoria explícita).
WITH population AS (
  SELECT * FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
)
SELECT coalesce("archiveReason", '<NULL>') AS archive_reason, count(*) AS client_count
FROM population
WHERE "isArchived"
GROUP BY 1
ORDER BY client_count DESC, archive_reason;

-- 3a. Timestamp forense derivado do sufixo epoch-ms colocado na neutralização.
-- "inferred" não equivale a uma coluna de auditoria. NULL significa que o
-- registro não traz um dos marcadores conhecidos.
WITH population AS (
  SELECT c.*,
         (regexp_match(coalesce(c.code, ''), '__(MERGED|LEGACY_DUP)__([0-9]{10,16})$'))[2] AS epoch_text
  FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
), inferred AS (
  SELECT *, CASE WHEN epoch_text IS NOT NULL
                 THEN to_timestamp(epoch_text::numeric / 1000.0) END AS inferred_archived_at
  FROM population
)
SELECT date_trunc('second', inferred_archived_at) AS inferred_archived_second,
       count(*) AS client_count
FROM inferred
WHERE "isArchived"
GROUP BY 1
ORDER BY 1 NULLS LAST;

-- 3b. Picos por minuto; útil se timestamps por registro não forem idênticos.
WITH population AS (
  SELECT c.*, (regexp_match(coalesce(c.code, ''), '__(MERGED|LEGACY_DUP)__([0-9]{10,16})$'))[2] AS epoch_text
  FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
)
SELECT date_trunc('minute', to_timestamp(epoch_text::numeric / 1000.0)) AS inferred_archive_minute,
       count(*) AS client_count
FROM population
WHERE "isArchived" AND epoch_text IS NOT NULL
GROUP BY 1
ORDER BY client_count DESC, inferred_archive_minute;

-- 4. Distribuição da criação (dia; mudar para 'hour' apenas após observar o volume).
WITH population AS (
  SELECT * FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
)
SELECT date_trunc('day', "createdAt") AS created_day,
       "isArchived", count(*) AS client_count
FROM population
GROUP BY 1, 2
ORDER BY 1, 2;

-- 5. Distribuição por vendedor (somente IDs técnicos).
WITH population AS (
  SELECT * FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
)
SELECT "ownerSellerId", "isArchived", count(*) AS client_count
FROM population
GROUP BY 1, 2
ORDER BY client_count DESC, "ownerSellerId", "isArchived";

-- 6. Presença do prefixo legado.
WITH population AS (
  SELECT * FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
)
SELECT (name ILIKE '[ARQUIVADO ERP DUP]%') AS has_legacy_prefix,
       count(*) AS client_count
FROM population
GROUP BY 1
ORDER BY 1 DESC;

-- 7. Documento/código neutralizados. O documento é reconhecido pelo marcador,
-- sem revelar seu valor; cnpjNormalized nulo isoladamente não prova neutralização.
WITH population AS (
  SELECT * FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
)
SELECT
  (cnpj ~ ' \[(MERGED INTO|LEGACY DUP) [^]]+\]$') AS document_has_neutralization_marker,
  (code ~ '__(MERGED|LEGACY_DUP)__[0-9]{10,16}$') AS code_has_neutralization_marker,
  ("cnpjNormalized" IS NULL) AS normalized_document_is_null,
  count(*) AS client_count
FROM population
WHERE "isArchived"
GROUP BY 1, 2, 3
ORDER BY client_count DESC;

-- 8. Arquivado com substituto ativo de mesmo documento original. Apenas hashes
-- são exibidos para permitir reconciliação sem materializar CPF/CNPJ.
WITH population AS (
  SELECT c.*,
         regexp_replace(split_part(coalesce(c.cnpj, ''), ' [', 1), '\D', '', 'g') AS original_doc
  FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
), active_docs AS (
  SELECT id, "ownerSellerId",
         coalesce(nullif("cnpjNormalized", ''), regexp_replace(coalesce(cnpj, ''), '\D', '', 'g')) AS normalized_doc
  FROM "Client"
  WHERE NOT "isArchived"
)
SELECT md5(p.original_doc) AS document_fingerprint,
       count(DISTINCT p.id) AS archived_clients,
       count(DISTINCT a.id) AS active_replacements,
       bool_or(a."ownerSellerId" = p."ownerSellerId") AS any_same_owner,
       bool_or(a."ownerSellerId" <> p."ownerSellerId") AS any_other_owner
FROM population p
JOIN active_docs a ON a.normalized_doc = p.original_doc
WHERE p."isArchived" AND length(p.original_doc) IN (11, 14)
GROUP BY p.original_doc
ORDER BY archived_clients DESC, document_fingerprint;

-- 9. Arquivado com candidato ativo em outro vendedor, por documento OU código
-- base. A saída é agregada e não expõe documento/nome.
WITH archived AS (
  SELECT c.*,
         regexp_replace(split_part(coalesce(c.cnpj, ''), ' [', 1), '\D', '', 'g') AS original_doc,
         regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') AS base_code
  FROM "Client" c
  WHERE c."isArchived"
    AND regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
), active AS (
  SELECT c.*,
         coalesce(nullif(c."cnpjNormalized", ''), regexp_replace(coalesce(c.cnpj, ''), '\D', '', 'g')) AS normalized_doc,
         regexp_replace(btrim(coalesce(c.code, '')), '^0+', '') AS base_code
  FROM "Client" c WHERE NOT c."isArchived"
)
SELECT a."ownerSellerId" AS archived_owner_id,
       v."ownerSellerId" AS active_owner_id,
       count(DISTINCT a.id) AS archived_with_other_owner_candidate,
       count(DISTINCT v.id) AS active_candidates
FROM archived a
JOIN active v ON v."ownerSellerId" <> a."ownerSellerId"
 AND ((length(a.original_doc) IN (11,14) AND v.normalized_doc = a.original_doc)
      OR (a.base_code <> '' AND v.base_code = a.base_code))
GROUP BY 1, 2
ORDER BY 3 DESC, 1, 2;

-- 10. Motivo × vendedor.
WITH population AS (
  SELECT * FROM "Client" c
  WHERE regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
)
SELECT coalesce("archiveReason", '<NULL>') AS archive_reason,
       "ownerSellerId", count(*) AS client_count
FROM population
WHERE "isArchived"
GROUP BY 1, 2
ORDER BY client_count DESC, archive_reason, "ownerSellerId";

-- 11. Primeiro, último, cobertura e maior lote inferidos pelo marcador.
WITH population AS (
  SELECT c.*, (regexp_match(coalesce(c.code, ''), '__(MERGED|LEGACY_DUP)__([0-9]{10,16})$'))[2] AS epoch_text
  FROM "Client" c
  WHERE c."isArchived"
    AND regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
), inferred AS (
  SELECT *, to_timestamp(epoch_text::numeric / 1000.0) AS archived_at
  FROM population WHERE epoch_text IS NOT NULL
), batches AS (
  SELECT date_trunc('second', archived_at) AS batch_second, count(*) AS batch_size
  FROM inferred GROUP BY 1
)
SELECT (SELECT count(*) FROM population) AS archived_population,
       (SELECT count(*) FROM inferred) AS timestamps_inferred,
       (SELECT min(archived_at) FROM inferred) AS first_inferred_archive,
       (SELECT max(archived_at) FROM inferred) AS last_inferred_archive,
       (SELECT max(archived_at) - min(archived_at) FROM inferred) AS inferred_span,
       (SELECT batch_second FROM batches ORDER BY batch_size DESC, batch_second LIMIT 1) AS largest_batch_at,
       (SELECT batch_size FROM batches ORDER BY batch_size DESC, batch_second LIMIT 1) AS largest_batch_size;

-- 12. ErpSyncRun que se sobrepõe à janela inferida (margem de 5 minutos).
WITH population AS (
  SELECT (regexp_match(coalesce(c.code, ''), '__(MERGED|LEGACY_DUP)__([0-9]{10,16})$'))[2] AS epoch_text
  FROM "Client" c
  WHERE c."isArchived"
    AND regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
), bounds AS (
  SELECT min(to_timestamp(epoch_text::numeric / 1000.0)) AS first_at,
         max(to_timestamp(epoch_text::numeric / 1000.0)) AS last_at
  FROM population WHERE epoch_text IS NOT NULL
)
SELECT r.id, r.scope, r.trigger, r.status, r."sellerId", r."authMode",
       r."correlationId", r."startedAt", r."finishedAt", r."syncedCount",
       r.metrics, r."errorMessage"
FROM "ErpSyncRun" r CROSS JOIN bounds b
WHERE b.first_at IS NOT NULL
  AND r."startedAt" <= b.last_at + interval '5 minutes'
  AND coalesce(r."finishedAt", r."startedAt") >= b.first_at - interval '5 minutes'
ORDER BY r."startedAt";

-- 13. Eventos de timeline potencialmente criados pelo merge/saneamento, por
-- segundo e vendedor. Não correlacionar somente por texto: confirme com logs/run.
WITH population AS (
  SELECT (regexp_match(coalesce(c.code, ''), '__(MERGED|LEGACY_DUP)__([0-9]{10,16})$'))[2] AS epoch_text
  FROM "Client" c
  WHERE c."isArchived"
    AND regexp_replace(split_part(split_part(btrim(coalesce(c.code, '')), '__MERGED__', 1), '__LEGACY_DUP__', 1), '^0+', '') = '5050'
), bounds AS (
  SELECT min(to_timestamp(epoch_text::numeric / 1000.0)) AS first_at,
         max(to_timestamp(epoch_text::numeric / 1000.0)) AS last_at
  FROM population WHERE epoch_text IS NOT NULL
)
SELECT date_trunc('second', t."createdAt") AS event_second,
       t."ownerSellerId", count(*) AS event_count
FROM "TimelineEvent" t CROSS JOIN bounds b
WHERE b.first_at IS NOT NULL
  AND t."createdAt" BETWEEN b.first_at - interval '5 minutes' AND b.last_at + interval '5 minutes'
  AND (t.description ILIKE '%duplicado%UltraFV3%'
       OR t.description ILIKE '%saneamento UltraFV3%')
GROUP BY 1, 2
ORDER BY 1, 2;

COMMIT;
