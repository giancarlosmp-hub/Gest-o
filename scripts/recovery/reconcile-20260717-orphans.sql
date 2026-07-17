\set ON_ERROR_STOP on

-- Incidente 2026-07-17: reconciliação sem alteração de dados.
-- Este script cria apenas tabelas TEMP e relatórios SELECT na sessão atual.
-- Não executa UPDATE, INSERT em tabelas de negócio, DELETE, DROP ou TRUNCATE.

BEGIN;

CREATE TEMP TABLE incident_20260717_client_orphans AS
WITH refs AS (
  SELECT 'Activity.clientId' AS relation_name, "clientId" AS orphan_id, COUNT(*) AS ref_count
    FROM "Activity" a LEFT JOIN "Client" c ON c.id = a."clientId"
   WHERE a."clientId" IS NOT NULL AND c.id IS NULL GROUP BY a."clientId"
  UNION ALL
  SELECT 'AgendaEvent.clientId', "clientId", COUNT(*)
    FROM "AgendaEvent" a LEFT JOIN "Client" c ON c.id = a."clientId"
   WHERE a."clientId" IS NOT NULL AND c.id IS NULL GROUP BY a."clientId"
  UNION ALL
  SELECT 'AgendaStop.clientId', "clientId", COUNT(*)
    FROM "AgendaStop" a LEFT JOIN "Client" c ON c.id = a."clientId"
   WHERE a."clientId" IS NOT NULL AND c.id IS NULL GROUP BY a."clientId"
  UNION ALL
  SELECT 'Opportunity.clientId', "clientId", COUNT(*)
    FROM "Opportunity" o LEFT JOIN "Client" c ON c.id = o."clientId"
   WHERE o."clientId" IS NOT NULL AND c.id IS NULL GROUP BY o."clientId"
  UNION ALL
  SELECT 'TimelineEvent.clientId', "clientId", COUNT(*)
    FROM "TimelineEvent" t LEFT JOIN "Client" c ON c.id = t."clientId"
   WHERE t."clientId" IS NOT NULL AND c.id IS NULL GROUP BY t."clientId"
), agg AS (
  SELECT orphan_id, SUM(ref_count) AS reference_count, string_agg(relation_name || ':' || ref_count, ', ' ORDER BY relation_name) AS reference_breakdown
  FROM refs GROUP BY orphan_id
), evidence AS (
  SELECT
    a.orphan_id,
    a.reference_count,
    a.reference_breakdown,
    max(o.title) FILTER (WHERE o.id IS NOT NULL) AS sample_opportunity_title,
    max(o."productOffered") FILTER (WHERE o."productOffered" IS NOT NULL) AS sample_product_offered,
    max(t.description) FILTER (WHERE t.id IS NOT NULL) AS sample_timeline_description,
    max(ac.notes) FILTER (WHERE ac.id IS NOT NULL) AS sample_activity_notes,
    max(ae.title) FILTER (WHERE ae.id IS NOT NULL) AS sample_agenda_title
  FROM agg a
  LEFT JOIN "Opportunity" o ON o."clientId" = a.orphan_id
  LEFT JOIN "TimelineEvent" t ON t."clientId" = a.orphan_id
  LEFT JOIN "Activity" ac ON ac."clientId" = a.orphan_id
  LEFT JOIN "AgendaEvent" ae ON ae."clientId" = a.orphan_id
  GROUP BY a.orphan_id, a.reference_count, a.reference_breakdown
)
SELECT
  e.orphan_id,
  NULL::text AS possible_current_id,
  NULL::text AS match_key,
  'none_from_child_tables'::text AS confidence,
  e.reference_count,
  e.reference_breakdown,
  'Sem snapshot estável de cliente nas tabelas filhas inspecionadas; revisar backups/cache ERP antes de criar pai arquivado.'::text AS recommended_decision,
  e.sample_opportunity_title,
  e.sample_product_offered,
  e.sample_timeline_description,
  e.sample_activity_notes,
  e.sample_agenda_title
FROM evidence e;

CREATE TEMP TABLE incident_20260717_product_orphans AS
WITH refs AS (
  SELECT 'OpportunityItem.productId' AS relation_name, "productId" AS orphan_id, COUNT(*) AS ref_count
    FROM "OpportunityItem" oi LEFT JOIN "Product" p ON p.id = oi."productId"
   WHERE oi."productId" IS NOT NULL AND p.id IS NULL GROUP BY oi."productId"
  UNION ALL
  SELECT 'ProductPrice.productId', "productId", COUNT(*)
    FROM "ProductPrice" pp LEFT JOIN "Product" p ON p.id = pp."productId"
   WHERE pp."productId" IS NOT NULL AND p.id IS NULL GROUP BY pp."productId"
), agg AS (
  SELECT orphan_id, SUM(ref_count) AS reference_count, string_agg(relation_name || ':' || ref_count, ', ' ORDER BY relation_name) AS reference_breakdown
  FROM refs GROUP BY orphan_id
), item_evidence AS (
  SELECT
    a.orphan_id,
    a.reference_count,
    a.reference_breakdown,
    max(oi."productNameSnapshot") FILTER (WHERE oi."productNameSnapshot" IS NOT NULL) AS item_name,
    max(oi."erpProductCode") FILTER (WHERE oi."erpProductCode" IS NOT NULL) AS item_erp_product_code,
    max(oi."erpProductClassCode") FILTER (WHERE oi."erpProductClassCode" IS NOT NULL) AS item_erp_product_class_code,
    max(pp."erpPriceId") FILTER (WHERE pp."erpPriceId" IS NOT NULL) AS sample_price_table,
    max(pp."branchCode") FILTER (WHERE pp."branchCode" IS NOT NULL) AS sample_branch_code,
    max(pp.price) AS max_price
  FROM agg a
  LEFT JOIN "OpportunityItem" oi ON oi."productId" = a.orphan_id
  LEFT JOIN "ProductPrice" pp ON pp."productId" = a.orphan_id
  GROUP BY a.orphan_id, a.reference_count, a.reference_breakdown
), candidates AS (
  SELECT
    e.*,
    p.id AS possible_current_id,
    CASE
      WHEN e.item_erp_product_code IS NOT NULL
       AND regexp_replace(lower(p."erpProductCode"), '^0+(?=\d)', '') = regexp_replace(lower(e.item_erp_product_code), '^0+(?=\d)', '')
       AND regexp_replace(lower(COALESCE(p."erpProductClassCode", 'default')), '^0+(?=\d)', '') = regexp_replace(lower(COALESCE(e.item_erp_product_class_code, 'default')), '^0+(?=\d)', '')
        THEN 'erpProductCode+erpProductClassCode'
      WHEN e.item_name IS NOT NULL AND lower(p.name) = lower(e.item_name)
        THEN 'name_exact'
      ELSE NULL
    END AS match_key
  FROM item_evidence e
  LEFT JOIN "Product" p
    ON (
      e.item_erp_product_code IS NOT NULL
      AND regexp_replace(lower(p."erpProductCode"), '^0+(?=\d)', '') = regexp_replace(lower(e.item_erp_product_code), '^0+(?=\d)', '')
      AND regexp_replace(lower(COALESCE(p."erpProductClassCode", 'default')), '^0+(?=\d)', '') = regexp_replace(lower(COALESCE(e.item_erp_product_class_code, 'default')), '^0+(?=\d)', '')
    ) OR (e.item_name IS NOT NULL AND lower(p.name) = lower(e.item_name))
), ranked AS (
  SELECT *, count(possible_current_id) FILTER (WHERE possible_current_id IS NOT NULL) OVER (PARTITION BY orphan_id) AS candidate_count
  FROM candidates
)
SELECT
  orphan_id,
  possible_current_id,
  match_key,
  CASE
    WHEN possible_current_id IS NOT NULL AND candidate_count = 1 AND match_key = 'erpProductCode+erpProductClassCode' THEN 'exact_safe'
    WHEN possible_current_id IS NOT NULL THEN 'probable_review'
    ELSE 'none'
  END AS confidence,
  reference_count,
  reference_breakdown,
  CASE
    WHEN possible_current_id IS NOT NULL AND candidate_count = 1 AND match_key = 'erpProductCode+erpProductClassCode'
      THEN 'Atualizar FKs para o produto atual após revisão; manter produto atual com seus flags/preços.'
    WHEN possible_current_id IS NOT NULL
      THEN 'Não alterar sem revisão humana; correspondência não é única ou não usa chave composta ERP.'
    ELSE 'Sem correspondência; criar Product inativo/suspenso somente como último recurso.'
  END AS recommended_decision,
  item_name,
  item_erp_product_code,
  item_erp_product_class_code,
  sample_price_table,
  sample_branch_code,
  max_price
FROM ranked;

SELECT * FROM incident_20260717_client_orphans ORDER BY confidence, reference_count DESC, orphan_id;
SELECT * FROM incident_20260717_product_orphans ORDER BY confidence, reference_count DESC, orphan_id;

ROLLBACK;
