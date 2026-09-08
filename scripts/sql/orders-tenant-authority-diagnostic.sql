BEGIN TRANSACTION READ ONLY;

-- Aggregate-only output.  Never add identifying dimensions to this report.
WITH order_scope AS (
  SELECT orders.id AS order_id,
         opportunities.id AS opportunity_id,
         clients.id AS client_id,
         clients."tenantId" AS client_tenant_id,
         sellers.id AS seller_id,
         sellers."isActive" AS seller_active
  FROM "ErpOrderSync" orders
  LEFT JOIN "Opportunity" opportunities ON opportunities.id = orders."opportunityId"
  LEFT JOIN "Client" clients ON clients.id = opportunities."clientId"
  LEFT JOIN "User" sellers ON sellers.id = orders."sellerId"
), historical_clients AS (
  SELECT DISTINCT client_id FROM order_scope WHERE client_id IS NOT NULL
)
SELECT metric, value
FROM (
  SELECT 1 ordinal, 'orders_total' metric, count(*)::bigint value FROM order_scope
  UNION ALL SELECT 2, 'orders_with_opportunity', count(*) FROM order_scope WHERE opportunity_id IS NOT NULL
  UNION ALL SELECT 3, 'orders_without_opportunity', count(*) FROM order_scope WHERE opportunity_id IS NULL
  UNION ALL SELECT 4, 'orders_with_client', count(*) FROM order_scope WHERE client_id IS NOT NULL
  UNION ALL SELECT 5, 'orders_without_client', count(*) FROM order_scope WHERE client_id IS NULL
  UNION ALL SELECT 6, 'orders_client_tenant_null', count(*) FROM order_scope WHERE client_id IS NOT NULL AND client_tenant_id IS NULL
  UNION ALL SELECT 7, 'orders_client_tenant_valid', count(*) FROM order_scope scope JOIN "Tenant" tenant ON tenant.id = scope.client_tenant_id
  UNION ALL SELECT 8, 'orders_seller_active', count(*) FROM order_scope WHERE seller_id IS NOT NULL AND seller_active
  UNION ALL SELECT 9, 'orders_seller_inactive', count(*) FROM order_scope WHERE seller_id IS NOT NULL AND NOT seller_active
  UNION ALL SELECT 10, 'orders_seller_missing', count(*) FROM order_scope WHERE seller_id IS NULL
  UNION ALL SELECT 11, 'historical_clients_tenant_null', count(*) FROM historical_clients scope JOIN "Client" clients ON clients.id = scope.client_id WHERE clients."tenantId" IS NULL
  UNION ALL SELECT 12, 'tenants_existing', count(*) FROM "Tenant"
  UNION ALL SELECT 13, 'tenants_active', count(*) FROM "Tenant" WHERE status = 'active'
  UNION ALL SELECT 14, 'historical_client_timeline', count(*) FROM "TimelineEvent" record JOIN historical_clients scope ON scope.client_id = record."clientId"
  UNION ALL SELECT 15, 'historical_client_activity', count(*) FROM "Activity" record JOIN historical_clients scope ON scope.client_id = record."clientId"
  UNION ALL SELECT 16, 'historical_opportunity_change_log', count(*) FROM "OpportunityChangeLog" record JOIN order_scope scope ON scope.opportunity_id = record."opportunityId"
  UNION ALL SELECT 17, 'orders_invalid_client_tenant_fk', count(*) FROM order_scope scope LEFT JOIN "Tenant" tenant ON tenant.id = scope.client_tenant_id WHERE scope.client_tenant_id IS NOT NULL AND tenant.id IS NULL
) diagnostics
ORDER BY ordinal;

WITH authority AS (
  SELECT
    (SELECT count(*) FROM "Tenant") AS tenant_count,
    (SELECT count(*) FROM "Tenant" WHERE status = 'active') AS active_tenant_count,
    (SELECT count(*) FROM "ErpOrderSync" orders LEFT JOIN "Opportunity" opportunity ON opportunity.id=orders."opportunityId" WHERE opportunity.id IS NULL) AS missing_opportunity_count,
    (SELECT count(*) FROM "ErpOrderSync" orders JOIN "Opportunity" opportunity ON opportunity.id=orders."opportunityId" LEFT JOIN "Client" client ON client.id=opportunity."clientId" WHERE client.id IS NULL) AS missing_client_count,
    (SELECT count(*) FROM "ErpOrderSync" orders JOIN "Opportunity" opportunity ON opportunity.id=orders."opportunityId" JOIN "Client" client ON client.id=opportunity."clientId" LEFT JOIN "Tenant" tenant ON tenant.id=client."tenantId" WHERE client."tenantId" IS NOT NULL AND tenant.id IS NULL) AS invalid_tenant_count
)
SELECT 'authority_ready' AS metric,
       CASE WHEN tenant_count=1 AND active_tenant_count=1 AND missing_opportunity_count=0
                  AND missing_client_count=0 AND invalid_tenant_count=0
            THEN 1 ELSE 0 END::bigint AS value
FROM authority;

ROLLBACK;
