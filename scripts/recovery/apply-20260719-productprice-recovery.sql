\set ON_ERROR_STOP on

-- Incident 2026-07-19: safe ProductPrice orphan recovery automation.
-- Run only against an isolated restored database first. Default mode is DRY_RUN/read-only.
-- To mutate data, all gates are required:
--   APPLY_RECOVERY=true psql ... -v apply_recovery=true -v expected_orphan_rows=273 -v expected_remaining_orphans=0 -f scripts/recovery/apply-20260719-productprice-recovery.sql
-- Optional:
--   -v june_product_table=public.incident_20260719_june_product_source
--
-- Recovery rules:
--   1) If the orphan productId exists in the June product source, restore Product with the same id as inactive/suspended.
--   2) Else update ProductPrice.productId only when audited evidence has an exact unique current Product match.
--   3) Never deletes ProductPrice. All writes happen in one transaction and are rolled back on mismatched counts.

\if :{?apply_recovery}
\else
  \set apply_recovery false
\endif
\if :{?expected_orphan_rows}
\else
  \set expected_orphan_rows 273
\endif
\if :{?expected_remaining_orphans}
\else
  \set expected_remaining_orphans 0
\endif
\if :{?june_product_table}
\else
  \set june_product_table ''
\endif

BEGIN;

CREATE TEMP TABLE _params AS SELECT (:expected_orphan_rows)::int AS expected_orphan_rows, (:expected_remaining_orphans)::int AS expected_remaining_orphans, (:'june_product_table')::text AS june_product_table;

CREATE TEMP TABLE _gate AS SELECT (:'apply_recovery' = 'true' AND coalesce(current_setting('app.apply_recovery', true), '') = 'true') AS enabled;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _gate WHERE enabled) THEN
    RAISE NOTICE 'DRY_RUN: no changes will be persisted. Set both psql -v apply_recovery=true and PGOPTIONS=-c app.apply_recovery=true (or SET app.apply_recovery=true) to apply.';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _gate WHERE enabled) THEN
    CREATE TABLE IF NOT EXISTS public.incident_20260719_productprice_recovery_audit (
      id bigserial PRIMARY KEY,
      run_id uuid NOT NULL DEFAULT gen_random_uuid(),
      action text NOT NULL,
      product_price_id text,
      orphan_product_id text NOT NULL,
      target_product_id text,
      previous_data jsonb NOT NULL,
      source_data jsonb NOT NULL,
      evidence jsonb NOT NULL,
      applied boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  ELSE
    CREATE TEMP TABLE incident_20260719_productprice_recovery_audit (
      id bigserial PRIMARY KEY,
      run_id uuid NOT NULL DEFAULT gen_random_uuid(),
      action text NOT NULL,
      product_price_id text,
      orphan_product_id text NOT NULL,
      target_product_id text,
      previous_data jsonb NOT NULL,
      source_data jsonb NOT NULL,
      evidence jsonb NOT NULL,
      applied boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END $$;

CREATE TEMP TABLE _orphan_prices AS
SELECT pp.*
FROM public."ProductPrice" pp
LEFT JOIN public."Product" p ON p.id = pp."productId"
WHERE p.id IS NULL;

DO $$
DECLARE expected int; actual int;
BEGIN
  SELECT expected_orphan_rows INTO expected FROM _params;
  SELECT count(*) INTO actual FROM _orphan_prices;
  IF actual <> expected THEN
    RAISE EXCEPTION 'Abort: ProductPrice orphan row count mismatch before recovery. expected %, got %', expected, actual;
  END IF;
END $$;

CREATE TEMP TABLE _june_products AS
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
  IF source_table = '' OR to_regclass(source_table) IS NULL THEN
    RAISE NOTICE 'June product source table not provided/found; only exact FK updates from existing audit maps can run.';
  ELSE
    EXECUTE format('INSERT INTO _june_products SELECT id, "erpProductCode", "erpProductClassCode", name, "className", unit, brand, "groupName", "isActive", "isSuspended", "stockQuantity", "minPrice", "defaultPrice", "rawErpPayload"::jsonb, "createdAt", "updatedAt" FROM %s', source_table);
  END IF;
END $$;

CREATE TEMP TABLE _restore_products AS
SELECT DISTINCT jp.*
FROM _june_products jp
JOIN (SELECT DISTINCT "productId" FROM _orphan_prices) op ON op."productId" = jp.id
LEFT JOIN public."Product" p ON p.id = jp.id
WHERE p.id IS NULL;

CREATE TEMP TABLE _fk_updates AS
WITH evidence AS (
  SELECT DISTINCT op."productId", jp."erpProductCode", jp."erpProductClassCode"
  FROM (SELECT DISTINCT "productId" FROM _orphan_prices) op
  JOIN _june_products jp ON jp.id = op."productId"
), candidates AS (
  SELECT e."productId" AS orphan_product_id, p.id AS target_product_id,
         count(*) OVER (PARTITION BY e."productId") AS candidate_count,
         jsonb_build_object('erpProductCode', e."erpProductCode", 'erpProductClassCode', e."erpProductClassCode", 'match', 'erpProductCode+erpProductClassCode') AS evidence
  FROM evidence e
  JOIN public."Product" p
    ON p.id <> e."productId"
   AND regexp_replace(lower(p."erpProductCode"), '^0+(?=\d)', '') = regexp_replace(lower(e."erpProductCode"), '^0+(?=\d)', '')
   AND regexp_replace(lower(coalesce(p."erpProductClassCode", 'default')), '^0+(?=\d)', '') = regexp_replace(lower(coalesce(e."erpProductClassCode", 'default')), '^0+(?=\d)', '')
)
SELECT * FROM candidates WHERE candidate_count = 1;

INSERT INTO public.incident_20260719_productprice_recovery_audit (action, orphan_product_id, previous_data, source_data, evidence, applied)
SELECT 'restore_product_same_id', rp.id, '{}'::jsonb, to_jsonb(rp), jsonb_build_object('source', (SELECT june_product_table FROM _params), 'safety', 'restored inactive and suspended'), (SELECT enabled FROM _gate)
FROM _restore_products rp
WHERE (SELECT enabled FROM _gate);

INSERT INTO public."Product" (id, "erpProductCode", "erpProductClassCode", name, "className", unit, brand, "groupName", "isActive", "isSuspended", "stockQuantity", "minPrice", "defaultPrice", "rawErpPayload", "createdAt", "updatedAt")
SELECT id, "erpProductCode", coalesce("erpProductClassCode", 'default'), coalesce(name, 'Produto histórico restaurado'), "className", unit, brand, "groupName", false, true, "stockQuantity", "minPrice", "defaultPrice", "rawErpPayload", coalesce("createdAt", now()), now()
FROM _restore_products
WHERE (SELECT enabled FROM _gate);

INSERT INTO public.incident_20260719_productprice_recovery_audit (action, product_price_id, orphan_product_id, target_product_id, previous_data, source_data, evidence, applied)
SELECT 'update_productprice_fk_exact_unique', pp.id, pp."productId", fu.target_product_id, to_jsonb(pp), jsonb_build_object('targetProductId', fu.target_product_id), fu.evidence, (SELECT enabled FROM _gate)
FROM _orphan_prices pp
JOIN _fk_updates fu ON fu.orphan_product_id = pp."productId"
LEFT JOIN _restore_products rp ON rp.id = pp."productId"
WHERE rp.id IS NULL AND (SELECT enabled FROM _gate);

UPDATE public."ProductPrice" pp
SET "productId" = fu.target_product_id, "updatedAt" = now()
FROM _fk_updates fu
LEFT JOIN _restore_products rp ON rp.id = fu.orphan_product_id
WHERE pp."productId" = fu.orphan_product_id AND rp.id IS NULL AND (SELECT enabled FROM _gate);

DO $$
DECLARE expected int; actual int;
BEGIN
  SELECT expected_remaining_orphans INTO expected FROM _params;
  SELECT count(*) INTO actual
  FROM public."ProductPrice" pp LEFT JOIN public."Product" p ON p.id = pp."productId"
  WHERE p.id IS NULL;
  IF (SELECT enabled FROM _gate) AND actual <> expected THEN
    RAISE EXCEPTION 'Abort: ProductPrice orphan row count mismatch after recovery. expected %, got %', expected, actual;
  END IF;
END $$;

SELECT (SELECT enabled FROM _gate) AS apply_enabled,
       (SELECT count(*) FROM _orphan_prices) AS starting_orphan_productprice_rows,
       (SELECT count(*) FROM _restore_products) AS products_to_restore_same_id,
       (SELECT count(*) FROM _fk_updates) AS distinct_exact_fk_update_targets;

\if :apply_recovery
COMMIT;
\else
ROLLBACK;
\endif
