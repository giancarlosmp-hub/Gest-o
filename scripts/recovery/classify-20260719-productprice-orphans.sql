\set ON_ERROR_STOP on

-- Incident 2026-07-19: read-only classification of ProductPrice orphan productIds.
-- Default-safe: this script only creates TEMP tables and SELECT reports in the current session.
-- Optional psql variables:
--   \set expected_orphan_rows 273
--   \set june_product_table 'public.incident_20260719_june_product_source'
--   \set fail_on_expected_mismatch true

\if :{?expected_orphan_rows}
\else
  \set expected_orphan_rows 273
\endif
\if :{?june_product_table}
\else
  \set june_product_table ''
\endif
\if :{?fail_on_expected_mismatch}
\else
  \set fail_on_expected_mismatch false
\endif

BEGIN READ ONLY;

CREATE TEMP TABLE _params AS SELECT (:expected_orphan_rows)::int AS expected_orphan_rows, (:fail_on_expected_mismatch)::boolean AS fail_on_expected_mismatch, (:'june_product_table')::text AS june_product_table;

CREATE TEMP TABLE _incident_productprice_orphans AS
SELECT pp.*
FROM public."ProductPrice" pp
LEFT JOIN public."Product" p ON p.id = pp."productId"
WHERE p.id IS NULL;

CREATE TEMP TABLE _incident_cache_products AS
WITH cfg AS (
  SELECT value::jsonb AS payload
  FROM public."AppConfig"
  WHERE key IN ('erp.ultrafv3.products', 'erp.ultrafv3.prices')
), rows AS (
  SELECT elem AS payload
  FROM cfg
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(cfg.payload) = 'array' THEN cfg.payload ELSE '[]'::jsonb END
  ) elem
), normalized AS (
  SELECT
    payload,
    coalesce(payload->>'CODPRODUTO', payload->>'COD_PRODUTO', payload->>'productCode', payload->>'erpProductCode', payload->>'produto') AS erp_product_code,
    coalesce(payload->>'CODPRODUTO_CLAS', payload->>'COD_PRODUTO_CLAS', payload->>'productClassCode', payload->>'erpProductClassCode', payload->>'classificacao', 'default') AS erp_product_class_code,
    coalesce(payload->>'DSCPRODUTO', payload->>'description', payload->>'name', payload->>'descricao', payload->>'NOME', 'Produto histórico sem descrição') AS product_name,
    coalesce(payload->>'DSCPRODUTO_CLAS', payload->>'DESCRICAO_CLASSE', payload->>'DSC_CLASSIFICACAO', payload->>'classificationName', payload->>'className', payload->>'nomeClassificacao') AS class_name,
    coalesce(payload->>'UNIDADE', payload->>'unit', payload->>'unidade') AS unit,
    coalesce(payload->>'MARCA', payload->>'brand', payload->>'marca') AS brand,
    coalesce(payload->>'DSCGRUPO', payload->>'group', payload->>'groupName', payload->>'grupo') AS group_name
  FROM rows
)
SELECT *,
  regexp_replace(lower(coalesce(erp_product_code, '')), '^0+(?=\d)', '') AS norm_code,
  regexp_replace(lower(coalesce(erp_product_class_code, 'default')), '^0+(?=\d)', '') AS norm_class
FROM normalized
WHERE erp_product_code IS NOT NULL;

CREATE TEMP TABLE _incident_june_products AS
SELECT NULL::text AS id, NULL::text AS "erpProductCode", NULL::text AS "erpProductClassCode", NULL::text AS name,
       NULL::text AS "className", NULL::text AS unit, NULL::text AS brand, NULL::text AS "groupName",
       NULL::boolean AS "isActive", NULL::boolean AS "isSuspended", NULL::double precision AS "stockQuantity",
       NULL::double precision AS "minPrice", NULL::double precision AS "defaultPrice", NULL::jsonb AS "rawErpPayload",
       NULL::timestamptz AS "createdAt", NULL::timestamptz AS "updatedAt"
WHERE false;

DO $$
DECLARE source_table text;
BEGIN
  SELECT june_product_table INTO source_table FROM _params;
IF source_table IS NOT NULL AND source_table <> '' AND to_regclass(source_table) IS NOT NULL THEN
    EXECUTE format('INSERT INTO _incident_june_products SELECT id, "erpProductCode", "erpProductClassCode", name, "className", unit, brand, "groupName", "isActive", "isSuspended", "stockQuantity", "minPrice", "defaultPrice", "rawErpPayload"::jsonb, "createdAt", "updatedAt" FROM %s', source_table);
  END IF;
END $$;

CREATE TEMP TABLE _incident_productprice_classification AS
WITH orphan_product_ids AS (
  SELECT "productId", count(*) AS orphan_price_rows
  FROM _incident_productprice_orphans
  GROUP BY "productId"
), june AS (
  SELECT op."productId", jp.*, count(*) OVER (PARTITION BY op."productId") AS june_match_count
  FROM orphan_product_ids op
  JOIN _incident_june_products jp ON jp.id = op."productId"
), cache_matches AS (
  SELECT j."productId", cp.*, count(*) OVER (PARTITION BY j."productId") AS cache_evidence_count
  FROM june j
  JOIN _incident_cache_products cp
    ON cp.norm_code = regexp_replace(lower(j."erpProductCode"), '^0+(?=\d)', '')
   AND cp.norm_class = regexp_replace(lower(coalesce(j."erpProductClassCode", 'default')), '^0+(?=\d)', '')
), current_exact AS (
  SELECT op."productId", p.id AS current_product_id, p."erpProductCode", p."erpProductClassCode", count(*) OVER (PARTITION BY op."productId") AS current_match_count
  FROM orphan_product_ids op
  JOIN june j ON j."productId" = op."productId"
  JOIN public."Product" p
    ON regexp_replace(lower(p."erpProductCode"), '^0+(?=\d)', '') = regexp_replace(lower(j."erpProductCode"), '^0+(?=\d)', '')
   AND regexp_replace(lower(coalesce(p."erpProductClassCode", 'default')), '^0+(?=\d)', '') = regexp_replace(lower(coalesce(j."erpProductClassCode", 'default')), '^0+(?=\d)', '')
)
SELECT
  op."productId" AS orphan_product_id,
  op.orphan_price_rows,
  (j.id IS NOT NULL) AS exists_same_id_in_june_backup,
  coalesce(j.june_match_count, 0) AS june_match_count,
  coalesce(ce.current_match_count, 0) AS exact_current_match_count,
  ce.current_product_id AS exact_current_product_id,
  coalesce(cm.cache_evidence_count, 0) AS erp_cache_evidence_count,
  j."erpProductCode" AS evidence_erp_product_code,
  j."erpProductClassCode" AS evidence_erp_product_class_code,
  CASE
    WHEN j.id IS NOT NULL THEN 'restore_same_id_from_june_backup'
    WHEN j.id IS NULL AND ce.current_match_count = 1 THEN 'exact_safe_update_fk'
    WHEN j.id IS NOT NULL AND ce.current_match_count > 1 THEN 'ambiguous'
    ELSE 'none'
  END AS classification
FROM orphan_product_ids op
LEFT JOIN june j ON j."productId" = op."productId"
LEFT JOIN current_exact ce ON ce."productId" = op."productId"
LEFT JOIN cache_matches cm ON cm."productId" = op."productId";

DO $$
DECLARE expected int; actual int; fail boolean;
BEGIN
  SELECT expected_orphan_rows, fail_on_expected_mismatch INTO expected, fail FROM _params;
  SELECT count(*) INTO actual FROM _incident_productprice_orphans;
  IF fail AND actual <> expected THEN
    RAISE EXCEPTION 'ProductPrice orphan row count mismatch: expected %, got %', expected, actual;
  END IF;
END $$;

SELECT count(*) AS orphan_productprice_rows, count(DISTINCT "productId") AS distinct_orphan_product_ids FROM _incident_productprice_orphans;
SELECT classification, count(*) AS distinct_product_ids, sum(orphan_price_rows) AS productprice_rows, sum(CASE WHEN erp_cache_evidence_count > 0 THEN 1 ELSE 0 END) AS product_ids_with_erp_cache_evidence FROM _incident_productprice_classification GROUP BY classification ORDER BY classification;
SELECT * FROM _incident_productprice_classification ORDER BY classification, orphan_product_id;

ROLLBACK;
