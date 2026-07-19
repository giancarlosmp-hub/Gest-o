\set ON_ERROR_STOP on

-- Incident 2026-07-19: gated cleanup for orphan ProductPrice rows after audit preservation.
-- Default mode is DRY_RUN. It does not create Product and does not touch valid ProductPrice rows.
-- Apply requires: -v apply_recovery=true. Optional expected_orphan_rows defaults to 273.
-- If the incident has already been recovered and zero orphan rows remain, the script exits with no changes.
-- Rollback is documented in docs/incidents/2026-07-19-final-recovery-runbook.md using previous_data JSONB.

\if :{?apply_recovery}
\else
  \set apply_recovery false
\endif
\if :{?expected_orphan_rows}
\else
  \set expected_orphan_rows 273
\endif

BEGIN;

CREATE TEMP TABLE _params AS
SELECT (:'apply_recovery' = 'true') AS apply_recovery,
       (:expected_orphan_rows)::int AS expected_orphan_rows;

CREATE TEMP TABLE _orphan_productprice AS
SELECT pp.*
FROM public."ProductPrice" pp
LEFT JOIN public."Product" p ON p.id = pp."productId"
WHERE p.id IS NULL;

DO $$
DECLARE
  apply boolean;
  expected int;
  actual int;
  nonzero int;
  nonnull_valid_from int;
  disallowed_erp_price_id int;
BEGIN
  SELECT apply_recovery, expected_orphan_rows INTO apply, expected FROM _params;
  SELECT count(*),
         count(*) FILTER (WHERE price <> 0),
         count(*) FILTER (WHERE "validFrom" IS NOT NULL),
         count(*) FILTER (WHERE "erpPriceId" IS NOT NULL AND "erpPriceId" <> '1')
    INTO actual, nonzero, nonnull_valid_from, disallowed_erp_price_id
  FROM _orphan_productprice;

  IF actual = 0 THEN
    RAISE NOTICE 'No orphan ProductPrice rows found; already recovered. No changes will be made.';
    RETURN;
  END IF;

  IF actual <> expected THEN
    RAISE EXCEPTION 'Abort: expected % orphan ProductPrice rows, found %', expected, actual;
  END IF;
  IF nonzero <> 0 OR nonnull_valid_from <> 0 OR disallowed_erp_price_id <> 0 THEN
    RAISE EXCEPTION 'Abort: unsafe orphan evidence. nonzero=%, nonnull_validFrom=%, disallowed_erpPriceId=%', nonzero, nonnull_valid_from, disallowed_erp_price_id;
  END IF;
  IF NOT apply THEN
    RAISE NOTICE 'DRY_RUN: % orphan zero-price ProductPrice rows qualify for audit+delete; transaction will roll back.', actual;
  END IF;
END $$;

DO $$
DECLARE apply boolean; actual int;
BEGIN
  SELECT apply_recovery INTO apply FROM _params;
  SELECT count(*) INTO actual FROM _orphan_productprice;
  IF apply AND actual > 0 THEN
    CREATE TABLE IF NOT EXISTS public.incident_20260719_orphan_productprice_audit (
      id bigserial PRIMARY KEY,
      product_price_id text NOT NULL UNIQUE,
      orphan_product_id text NOT NULL,
      previous_data jsonb NOT NULL,
      evidence jsonb NOT NULL,
      cleanup_run_id uuid NOT NULL DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  ELSE
    CREATE TEMP TABLE incident_20260719_orphan_productprice_audit (
      id bigserial PRIMARY KEY,
      product_price_id text NOT NULL UNIQUE,
      orphan_product_id text NOT NULL,
      previous_data jsonb NOT NULL,
      evidence jsonb NOT NULL,
      cleanup_run_id uuid NOT NULL DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END $$;

INSERT INTO incident_20260719_orphan_productprice_audit (product_price_id, orphan_product_id, previous_data, evidence)
SELECT op.id,
       op."productId",
       to_jsonb(op),
       jsonb_build_object(
         'reason', 'orphan_productprice_zero_price_cleanup_20260719',
         'product_missing', true,
         'price', op.price,
         'validFrom', op."validFrom",
         'erpPriceId', op."erpPriceId"
       )
FROM _orphan_productprice op
WHERE (SELECT apply_recovery FROM _params)
ON CONFLICT (product_price_id) DO NOTHING;

DO $$
DECLARE expected int; audited int; actual int;
BEGIN
  SELECT expected_orphan_rows INTO expected FROM _params;
  SELECT count(*) INTO actual FROM _orphan_productprice;
  IF actual = 0 THEN
    RETURN;
  END IF;
  SELECT count(*) INTO audited
  FROM incident_20260719_orphan_productprice_audit a
  JOIN _orphan_productprice op ON op.id = a.product_price_id;
  IF (SELECT apply_recovery FROM _params) AND audited <> expected THEN
    RAISE EXCEPTION 'Abort: audit preservation mismatch before delete. expected %, audited %', expected, audited;
  END IF;
END $$;

DELETE FROM public."ProductPrice" pp
USING _orphan_productprice op
WHERE pp.id = op.id
  AND (SELECT apply_recovery FROM _params);

DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM public."ProductPrice" pp
  LEFT JOIN public."Product" p ON p.id = pp."productId"
  WHERE p.id IS NULL;
  IF (SELECT apply_recovery FROM _params) AND remaining <> 0 THEN
    RAISE EXCEPTION 'Abort: ProductPrice orphans remain after cleanup: %', remaining;
  END IF;
END $$;

SELECT (SELECT apply_recovery FROM _params) AS apply_recovery,
       (SELECT count(*) FROM _orphan_productprice) AS starting_orphan_productprice_rows,
       (SELECT count(*) FROM _orphan_productprice WHERE price = 0 AND "validFrom" IS NULL AND ("erpPriceId" IS NULL OR "erpPriceId" = '1')) AS safe_cleanup_candidate_rows,
       (SELECT count(*) FROM public."ProductPrice" pp LEFT JOIN public."Product" p ON p.id = pp."productId" WHERE p.id IS NULL) AS remaining_orphan_productprice_rows;

\if :apply_recovery
COMMIT;
\else
ROLLBACK;
\endif
