\set ON_ERROR_STOP on

-- Incident 2026-07-19: read-only report for the 73 still-generic archived historical clients.
-- No automatic updates are performed. Generic titles/crops/cities/names are never used as automatic proof.
-- Expected real result after manual validation: 73 probable_review, 0 exact_safe, 0 ERP orders.
-- Optional psql variables: -v expected_generic_clients=73 -v fail_on_expected_mismatch=true

\if :{?expected_generic_clients}
\else
  \set expected_generic_clients 73
\endif
\if :{?fail_on_expected_mismatch}
\else
  \set fail_on_expected_mismatch true
\endif

BEGIN READ ONLY;

WITH params AS (
  SELECT (:expected_generic_clients)::int AS expected_generic_clients,
         (:fail_on_expected_mismatch)::boolean AS fail_on_expected_mismatch
), candidate_clients AS (
  SELECT c.*
  FROM public."Client" c
  WHERE c."isArchived" = true
    AND c."archiveReason" = 'INCIDENT_20260718_MISSING_PARENT_RESTORED'
    AND c.name LIKE '[RECUPERADO]%'
), referenced_clients AS (
  SELECT c.*
  FROM candidate_clients c
  WHERE EXISTS (SELECT 1 FROM public."Opportunity" o WHERE o."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."Activity" a WHERE a."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."AgendaEvent" ae WHERE ae."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."AgendaStop" ags WHERE ags."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."Contact" ct WHERE ct."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."TimelineEvent" te WHERE te."clientId" = c.id)
), active_code_matches AS (
  SELECT rc.id AS historical_client_id,
         count(ac.id) FILTER (WHERE ac.id IS NOT NULL)::int AS active_client_code_match_count,
         min(ac.id) FILTER (WHERE ac.id IS NOT NULL) AS active_client_code_match_id
  FROM referenced_clients rc
  LEFT JOIN public."Client" ac
    ON rc.code IS NOT NULL
   AND ac.code = rc.code
   AND ac."isArchived" = false
  GROUP BY rc.id
), erp_orders AS (
  SELECT o."clientId",
         count(eos.id)::int AS erp_order_count,
         jsonb_agg(jsonb_build_object('erpOrderSyncId', eos.id, 'status', eos.status, 'numPedido', eos."numPedido", 'payloadPARCEIRO', eos."payloadSent" #>> '{PARCEIRO}') ORDER BY eos."createdAt" DESC) FILTER (WHERE eos.id IS NOT NULL) AS erp_order_evidence
  FROM public."Opportunity" o
  LEFT JOIN public."ErpOrderSync" eos ON eos."opportunityId" = o.id
  GROUP BY o."clientId"
), rollup AS (
  SELECT
    rc.id AS historical_client_id,
    rc.code,
    rc.name,
    rc."fantasyName",
    rc.city,
    rc.state,
    rc."ownerSellerId",
    coalesce(acm.active_client_code_match_count, 0) AS active_client_code_match_count,
    acm.active_client_code_match_id,
    (SELECT count(*) FROM public."Opportunity" o WHERE o."clientId" = rc.id)::int AS opportunity_count,
    (SELECT count(*) FROM public."Activity" a WHERE a."clientId" = rc.id)::int AS activity_count,
    (SELECT count(*) FROM public."AgendaEvent" ae WHERE ae."clientId" = rc.id)::int AS agenda_event_count,
    (SELECT count(*) FROM public."AgendaStop" ags WHERE ags."clientId" = rc.id)::int AS agenda_stop_count,
    (SELECT count(*) FROM public."Contact" ct WHERE ct."clientId" = rc.id)::int AS contact_count,
    (SELECT count(*) FROM public."TimelineEvent" te WHERE te."clientId" = rc.id)::int AS timeline_event_count,
    coalesce(eo.erp_order_count, 0) AS erp_order_count,
    eo.erp_order_evidence
  FROM referenced_clients rc
  LEFT JOIN active_code_matches acm ON acm.historical_client_id = rc.id
  LEFT JOIN erp_orders eo ON eo."clientId" = rc.id
), classified AS (
  SELECT *,
    CASE
      WHEN code IS NOT NULL AND active_client_code_match_count = 1 THEN 'exact_safe'
      ELSE 'probable_review'
    END AS classification,
    CASE
      WHEN code IS NOT NULL AND active_client_code_match_count = 1 THEN 'Unique active Client.code match; requires human approval before any future merge. This report does not update.'
      ELSE 'Keep archived and readable. Do not auto-match from title, crop, city or partial/generic name.'
    END AS recommendation
  FROM rollup
), summary AS (
  SELECT count(*)::int AS referenced_generic_clients,
         count(*) FILTER (WHERE classification = 'exact_safe')::int AS exact_safe,
         count(*) FILTER (WHERE classification = 'probable_review')::int AS probable_review,
         coalesce(sum(erp_order_count), 0)::int AS erp_orders
  FROM classified
), abort_if_requested AS (
  SELECT CASE
    WHEN p.fail_on_expected_mismatch AND s.referenced_generic_clients <> p.expected_generic_clients THEN 1 / 0
    ELSE 1
  END AS guard
  FROM summary s CROSS JOIN params p
)
SELECT s.*, p.expected_generic_clients
FROM summary s CROSS JOIN params p CROSS JOIN abort_if_requested;

WITH candidate_clients AS (
  SELECT c.*
  FROM public."Client" c
  WHERE c."isArchived" = true
    AND c."archiveReason" = 'INCIDENT_20260718_MISSING_PARENT_RESTORED'
    AND c.name LIKE '[RECUPERADO]%'
), referenced_clients AS (
  SELECT c.*
  FROM candidate_clients c
  WHERE EXISTS (SELECT 1 FROM public."Opportunity" o WHERE o."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."Activity" a WHERE a."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."AgendaEvent" ae WHERE ae."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."AgendaStop" ags WHERE ags."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."Contact" ct WHERE ct."clientId" = c.id)
     OR EXISTS (SELECT 1 FROM public."TimelineEvent" te WHERE te."clientId" = c.id)
), detail AS (
  SELECT
    rc.id AS historical_client_id,
    rc.code,
    rc.name,
    rc.city,
    rc.state,
    (SELECT count(*) FROM public."Client" ac WHERE rc.code IS NOT NULL AND ac.code = rc.code AND ac."isArchived" = false)::int AS active_client_code_match_count,
    (SELECT count(*) FROM public."Opportunity" o WHERE o."clientId" = rc.id)::int AS opportunity_count,
    (SELECT count(*) FROM public."Activity" a WHERE a."clientId" = rc.id)::int AS activity_count,
    (SELECT count(*) FROM public."AgendaEvent" ae WHERE ae."clientId" = rc.id)::int AS agenda_event_count,
    (SELECT count(*) FROM public."AgendaStop" ags WHERE ags."clientId" = rc.id)::int AS agenda_stop_count,
    (SELECT count(*) FROM public."Contact" ct WHERE ct."clientId" = rc.id)::int AS contact_count,
    (SELECT count(*) FROM public."TimelineEvent" te WHERE te."clientId" = rc.id)::int AS timeline_event_count,
    (SELECT count(eos.id) FROM public."Opportunity" o JOIN public."ErpOrderSync" eos ON eos."opportunityId" = o.id WHERE o."clientId" = rc.id)::int AS erp_order_count
  FROM referenced_clients rc
)
SELECT *,
  CASE WHEN code IS NOT NULL AND active_client_code_match_count = 1 THEN 'exact_safe' ELSE 'probable_review' END AS classification,
  CASE WHEN code IS NOT NULL AND active_client_code_match_count = 1
       THEN 'Human review required before any future change; report only.'
       ELSE 'Keep archived and readable; no automatic merge/rename.'
  END AS recommendation
FROM detail
ORDER BY classification, historical_client_id;

COMMIT;
