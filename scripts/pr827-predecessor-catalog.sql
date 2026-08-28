BEGIN TRANSACTION READ ONLY;
WITH roots(name) AS (VALUES
 ('KnowledgeDocument'),('Client'),('AgendaEvent'),('Goal'),('ActivityKPI'),('Sale'),
 ('SellerTerritoryCity'),('AppConfig'),('Product'),('ErpSyncRun'),('ErpSyncLock')
), checks AS (
 SELECT r.name,
   EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=r.name AND c.column_name='tenantId' AND c.is_nullable='YES' AND c.data_type='text') AS column_ok,
   to_regclass(format('public.%I',r.name||'_tenantId_idx')) IS NOT NULL AS index_ok,
   EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.conname=r.name||'_tenantId_fkey' AND c.contype='f') AS fk_ok
 FROM roots r
)
SELECT 'PREDECESSOR_CATALOG_STATE', CASE
 WHEN count(*)=11 AND bool_and(column_ok AND index_ok AND fk_ok) AND to_regclass('public."Tenant"') IS NOT NULL THEN 'COMPLETE'
 WHEN bool_or(column_ok OR index_ok OR fk_ok) THEN 'PARTIAL'
 ELSE 'ABSENT' END
FROM checks;
COMMIT;
