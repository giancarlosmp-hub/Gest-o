\set ON_ERROR_STOP on

-- Incident 2026-07-19: read-only classification of ProductPrice orphan rows.
-- Uses CTE-only SELECTs inside a READ ONLY transaction; no TEMP or permanent objects.
-- Optional psql variables:
--   \set expected_orphan_rows 273
--   \set fail_on_expected_mismatch true

\if :{?expected_orphan_rows}
\else
  \set expected_orphan_rows 273
\endif
\if :{?fail_on_expected_mismatch}
\else
  \set fail_on_expected_mismatch false
\endif

BEGIN READ ONLY;

WITH params AS (
  SELECT (:expected_orphan_rows)::int AS expected_orphan_rows,
         (:fail_on_expected_mismatch)::boolean AS fail_on_expected_mismatch
), orphan_prices AS (
  SELECT pp.*
  FROM public."ProductPrice" pp
  LEFT JOIN public."Product" p ON p.id = pp."productId"
  WHERE p.id IS NULL
), validation AS (
  SELECT
    count(*)::int AS actual_orphan_rows,
    count(DISTINCT "productId")::int AS distinct_orphan_product_ids,
    count(*) FILTER (WHERE price = 0)::int AS zero_price_rows,
    count(*) FILTER (WHERE price <> 0)::int AS nonzero_price_rows,
    count(*) FILTER (WHERE "validFrom" IS NULL)::int AS null_valid_from_rows,
    count(*) FILTER (WHERE "validFrom" IS NOT NULL)::int AS nonnull_valid_from_rows,
    count(*) FILTER (WHERE "erpPriceId" IS NULL)::int AS null_erp_price_id_rows,
    count(*) FILTER (WHERE "erpPriceId" = '1')::int AS generic_erp_price_id_1_rows,
    count(*) FILTER (WHERE "erpPriceId" IS NOT NULL AND "erpPriceId" <> '1')::int AS other_erp_price_id_rows
  FROM orphan_prices
), guarded AS (
  SELECT v.*,
         p.expected_orphan_rows,
         CASE
           WHEN v.actual_orphan_rows = 0 THEN 'already_recovered_no_action'
           WHEN v.actual_orphan_rows = p.expected_orphan_rows
            AND v.nonzero_price_rows = 0
            AND v.nonnull_valid_from_rows = 0
            AND v.other_erp_price_id_rows = 0
             THEN 'safe_zero_price_cleanup_candidate'
           ELSE 'abort_divergent_evidence'
         END AS classification
  FROM validation v CROSS JOIN params p
), abort_if_requested AS (
  SELECT CASE
    WHEN p.fail_on_expected_mismatch
     AND g.actual_orphan_rows NOT IN (0, p.expected_orphan_rows)
      THEN 1 / 0
    ELSE 1
  END AS guard
  FROM guarded g CROSS JOIN params p
)
SELECT g.*
FROM guarded g, abort_if_requested;

WITH orphan_prices AS (
  SELECT pp.*
  FROM public."ProductPrice" pp
  LEFT JOIN public."Product" p ON p.id = pp."productId"
  WHERE p.id IS NULL
)
SELECT
  "productId" AS orphan_product_id,
  count(*) AS orphan_productprice_rows,
  count(*) FILTER (WHERE price = 0) AS zero_price_rows,
  count(*) FILTER (WHERE "validFrom" IS NULL) AS null_valid_from_rows,
  count(*) FILTER (WHERE "erpPriceId" IS NULL) AS null_erp_price_id_rows,
  count(*) FILTER (WHERE "erpPriceId" = '1') AS generic_erp_price_id_1_rows,
  jsonb_agg(to_jsonb(orphan_prices) ORDER BY id) AS rows_to_preserve_before_cleanup
FROM orphan_prices
GROUP BY "productId"
ORDER BY "productId";

COMMIT;
