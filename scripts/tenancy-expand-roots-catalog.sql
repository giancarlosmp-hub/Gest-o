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
   format('source=%s;source_columns=%s;target=%s;target_columns=%s;delete=%s;update=%s;validated=%s',
     src.relname, src_cols.names, dst.relname, dst_cols.names,
     CASE con.confdeltype
       WHEN 'a'::"char" THEN 'NO_ACTION' WHEN 'r'::"char" THEN 'RESTRICT'
       WHEN 'c'::"char" THEN 'CASCADE' WHEN 'n'::"char" THEN 'SET_NULL'
       WHEN 'd'::"char" THEN 'SET_DEFAULT' ELSE 'UNKNOWN('||con.confdeltype::text||')' END,
     CASE con.confupdtype
       WHEN 'a'::"char" THEN 'NO_ACTION' WHEN 'r'::"char" THEN 'RESTRICT'
       WHEN 'c'::"char" THEN 'CASCADE' WHEN 'n'::"char" THEN 'SET_NULL'
       WHEN 'd'::"char" THEN 'SET_DEFAULT' ELSE 'UNKNOWN('||con.confupdtype::text||')' END,
     CASE WHEN con.convalidated THEN 'TRUE' ELSE 'FALSE' END)
 FROM pg_constraint con JOIN pg_class src ON src.oid=con.conrelid
 JOIN pg_namespace ns ON ns.oid=src.relnamespace JOIN roots r ON r.table_name=src.relname
 JOIN pg_class dst ON dst.oid=con.confrelid
 CROSS JOIN LATERAL (
   SELECT string_agg(att.attname, ',' ORDER BY key.ordinality) names
   FROM unnest(con.conkey) WITH ORDINALITY key(attnum, ordinality)
   JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=key.attnum
 ) src_cols
 CROSS JOIN LATERAL (
   SELECT string_agg(att.attname, ',' ORDER BY key.ordinality) names
   FROM unnest(con.confkey) WITH ORDINALITY key(attnum, ordinality)
   JOIN pg_attribute att ON att.attrelid=con.confrelid AND att.attnum=key.attnum
 ) dst_cols
 WHERE ns.nspname='public' AND con.contype='f' AND con.conname=r.table_name||'_tenantId_fkey'
)
SELECT kind,object,detail FROM inventory ORDER BY kind,object;
