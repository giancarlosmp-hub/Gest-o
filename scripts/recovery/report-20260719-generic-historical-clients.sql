\set ON_ERROR_STOP on

-- Incident 2026-07-19: read-only report for the 73 still-generic historical clients.
-- No automatic updates are performed. Probable matches require human review.
-- Optional psql variable: -v expected_generic_clients=73

\if :{?expected_generic_clients}
\else
  \set expected_generic_clients 73
\endif

BEGIN READ ONLY;

CREATE TEMP TABLE _params AS SELECT (:expected_generic_clients)::int AS expected_generic_clients;

CREATE TEMP TABLE _generic_clients AS
SELECT c.*
FROM public."Client" c
WHERE c."isArchived" = true
  AND (
    c.name ILIKE '[HISTÓRICO] Cliente sem cadastro atual%'
    OR c.name ILIKE '[HISTÓRICO ERP %] Cliente sem cadastro atual%'
    OR coalesce(c."archiveReason", '') ILIKE '%incidente%'
  )
  AND NOT EXISTS (SELECT 1 FROM public.incident_20260719_erp_code_enrichment_audit a WHERE a.client_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM public.incident_20260719_erp_partner_client_map m WHERE m.historical_client_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM public.incident_20260718_client_map m WHERE m.old_client_id = c.id);

DO $$
DECLARE expected int; actual int;
BEGIN
  SELECT expected_generic_clients INTO expected FROM _params;
  SELECT count(*) INTO actual FROM _generic_clients;
  IF actual <> expected THEN
    RAISE NOTICE 'Generic historical client count differs from incident expectation: expected %, got %. Report will continue read-only.', expected, actual;
  END IF;
END $$;

WITH erp_orders AS (
  SELECT o."clientId", count(eos.*) AS erp_order_count,
         jsonb_agg(jsonb_build_object('erpOrderSyncId', eos.id, 'status', eos.status, 'numPedido', eos."numPedido", 'payloadPARCEIRO', eos."payloadSent" #>> '{PARCEIRO}') ORDER BY eos."createdAt" DESC) FILTER (WHERE eos.id IS NOT NULL) AS erp_order_evidence
  FROM public."Opportunity" o
  LEFT JOIN public."ErpOrderSync" eos ON eos."opportunityId" = o.id
  GROUP BY o."clientId"
), rollup AS (
  SELECT
    c.id AS historical_client_id,
    c.code,
    c.name,
    c."fantasyName",
    c.city,
    c.state,
    c."ownerSellerId",
    count(DISTINCT o.id) AS opportunity_count,
    count(DISTINCT a.id) AS activity_count,
    count(DISTINCT ags.id) AS agenda_stop_count,
    count(DISTINCT te.id) AS timeline_event_count,
    coalesce(max(eo.erp_order_count), 0) AS erp_order_count,
    jsonb_agg(DISTINCT jsonb_build_object('id', o.id, 'title', o.title, 'stage', o.stage, 'value', o.value, 'createdAt', o."createdAt")) FILTER (WHERE o.id IS NOT NULL) AS opportunities,
    jsonb_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'notes', a.notes, 'dueDate', a."dueDate")) FILTER (WHERE a.id IS NOT NULL) AS activities,
    jsonb_agg(DISTINCT jsonb_build_object('id', ags.id, 'agendaEventId', ags."agendaEventId", 'city', ags.city, 'notes', ags.notes)) FILTER (WHERE ags.id IS NOT NULL) AS agenda_stops,
    jsonb_agg(DISTINCT jsonb_build_object('id', te.id, 'type', te.type, 'description', te.description, 'createdAt', te."createdAt")) FILTER (WHERE te.id IS NOT NULL) AS timeline_events,
    max(eo.erp_order_evidence) AS erp_order_evidence
  FROM _generic_clients c
  LEFT JOIN public."Opportunity" o ON o."clientId" = c.id
  LEFT JOIN public."Activity" a ON a."clientId" = c.id
  LEFT JOIN public."AgendaStop" ags ON ags."clientId" = c.id
  LEFT JOIN public."TimelineEvent" te ON te."clientId" = c.id
  LEFT JOIN erp_orders eo ON eo."clientId" = c.id
  GROUP BY c.id, c.code, c.name, c."fantasyName", c.city, c.state, c."ownerSellerId"
)
SELECT *,
  CASE
    WHEN code IS NOT NULL AND erp_order_count > 0 THEN 'exact_safe'
    WHEN opportunity_count > 0 OR activity_count > 0 OR agenda_stop_count > 0 OR timeline_event_count > 0 THEN 'probable_review'
    ELSE 'none'
  END AS classification,
  CASE
    WHEN code IS NOT NULL AND erp_order_count > 0 THEN 'Only review/apply if ERP code is independently proven unique; this report does not update.'
    WHEN opportunity_count > 0 OR activity_count > 0 OR agenda_stop_count > 0 OR timeline_event_count > 0 THEN 'Human review required; do not auto-match from generic titles/crops.'
    ELSE 'No reliable evidence found; keep archived historical placeholder.'
  END AS recommendation
FROM rollup
ORDER BY classification, historical_client_id;

ROLLBACK;
