-- Read-only, deterministic control-plane inventory. Never include application rows.
WITH catalog AS (
SELECT 'enum'::text AS kind, t.typname::text AS object, e.enumsortorder::int AS position, e.enumlabel::text AS detail
FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname='public' AND t.typname IN ('TenantStatus','TenantMembershipStatus','TenantRole')
UNION ALL
SELECT 'table'::text, c.relname::text, 0, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('Tenant','TenantMembership')
UNION ALL
SELECT 'column'::text, (c.table_name||'.'||c.column_name)::text, c.ordinal_position,
       (c.data_type::text||'|'||coalesce(c.udt_name::text,'')||'|'||c.is_nullable::text||'|'||coalesce(c.column_default::text,''))::text
FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name IN ('Tenant','TenantMembership')
UNION ALL
SELECT CASE con.contype WHEN 'p' THEN 'pk'::text WHEN 'c' THEN 'check'::text END,
       con.conname::text, 0, pg_get_constraintdef(con.oid, true)::text
FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('Tenant','TenantMembership') AND con.contype IN ('p','c')
UNION ALL
SELECT 'fk'::text, con.conname::text, 0,
       format(
         'source_schema=%s;source=%s;source_columns=%s;target_schema=%s;target=%s;target_columns=%s;delete=%s;update=%s;validated=%s',
         src_ns.nspname,
         src.relname,
         src_cols.columns,
         dst_ns.nspname,
         dst.relname,
         dst_cols.columns,
         CASE con.confdeltype WHEN 'a'::"char" THEN 'NO ACTION'::text WHEN 'r'::"char" THEN 'RESTRICT'::text WHEN 'c'::"char" THEN 'CASCADE'::text WHEN 'n'::"char" THEN 'SET NULL'::text WHEN 'd'::"char" THEN 'SET DEFAULT'::text ELSE format('UNKNOWN:%s', con.confdeltype::text) END,
         CASE con.confupdtype WHEN 'a'::"char" THEN 'NO ACTION'::text WHEN 'r'::"char" THEN 'RESTRICT'::text WHEN 'c'::"char" THEN 'CASCADE'::text WHEN 'n'::"char" THEN 'SET NULL'::text WHEN 'd'::"char" THEN 'SET DEFAULT'::text ELSE format('UNKNOWN:%s', con.confupdtype::text) END,
         con.convalidated::text
       )::text
FROM pg_constraint con
JOIN pg_class src ON src.oid=con.conrelid
JOIN pg_namespace src_ns ON src_ns.oid=src.relnamespace
JOIN pg_class dst ON dst.oid=con.confrelid
JOIN pg_namespace dst_ns ON dst_ns.oid=dst.relnamespace
CROSS JOIN LATERAL (
  SELECT string_agg(att.attname, ',' ORDER BY keys.ordinality) AS columns
  FROM unnest(con.conkey) WITH ORDINALITY AS keys(attnum, ordinality)
  JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=keys.attnum
) src_cols
CROSS JOIN LATERAL (
  SELECT string_agg(att.attname, ',' ORDER BY keys.ordinality) AS columns
  FROM unnest(con.confkey) WITH ORDINALITY AS keys(attnum, ordinality)
  JOIN pg_attribute att ON att.attrelid=con.confrelid AND att.attnum=keys.attnum
) dst_cols
WHERE src_ns.nspname='public' AND src.relname='TenantMembership' AND con.contype='f'
UNION ALL
SELECT 'index'::text, indexname::text, 0, indexdef::text FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('Tenant','TenantMembership')
)
SELECT kind, object, position, detail FROM catalog
UNION ALL
SELECT 'meta'::text, 'detail_sql_type'::text, 0, (SELECT pg_typeof(detail)::text FROM catalog LIMIT 1)
ORDER BY 1,2,3;
