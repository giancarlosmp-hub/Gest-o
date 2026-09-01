WITH roots(table_name) AS (VALUES
 ('KnowledgeDocument'),('Client'),('AgendaEvent'),('Goal'),('ActivityKPI'),('Sale'),
 ('SellerTerritoryCity'),('AppConfig'),('Product'),('ErpSyncRun'),('ErpSyncLock')
), inventory AS (
 SELECT 'column'::text kind, c.table_name||'.tenantId' object,
        c.data_type||'|nullable='||c.is_nullable||'|default='||coalesce(c.column_default,'') detail
 FROM information_schema.columns c JOIN roots r USING (table_name)
 WHERE c.table_schema='public' AND c.column_name='tenantId'
 UNION ALL
 SELECT 'index', i.indexname, i.indexdef FROM pg_indexes i JOIN roots r ON r.table_name=i.tablename
 WHERE i.schemaname='public' AND i.indexname=r.table_name||'_tenantId_idx'
 UNION ALL
 SELECT 'fk', con.conname,
   format('%s.tenantId->%s.id|delete=%s|update=%s|validated=%s',src.relname,dst.relname,
     CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' ELSE con.confdeltype::text END,
     CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' ELSE con.confupdtype::text END,con.convalidated)
 FROM pg_constraint con JOIN pg_class src ON src.oid=con.conrelid
 JOIN pg_namespace ns ON ns.oid=src.relnamespace JOIN roots r ON r.table_name=src.relname
 JOIN pg_class dst ON dst.oid=con.confrelid
 WHERE ns.nspname='public' AND con.contype='f' AND con.conname=r.table_name||'_tenantId_fkey'
)
SELECT kind,object,detail FROM inventory ORDER BY kind,object;
