-- Read-only, deterministic control-plane inventory. Never include application rows.
SELECT 'enum' AS kind, t.typname AS object, e.enumsortorder::int AS position, e.enumlabel AS detail
FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname='public' AND t.typname IN ('TenantStatus','TenantMembershipStatus','TenantRole')
UNION ALL
SELECT 'table', c.relname, 0, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('Tenant','TenantMembership')
UNION ALL
SELECT 'column', c.table_name||'.'||c.column_name, c.ordinal_position,
       c.data_type||'|'||coalesce(c.udt_name,'')||'|'||c.is_nullable||'|'||coalesce(c.column_default,'')
FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name IN ('Tenant','TenantMembership')
UNION ALL
SELECT CASE con.contype WHEN 'p' THEN 'pk' WHEN 'c' THEN 'check' END,
       con.conname, 0, pg_get_constraintdef(con.oid, true)
FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('Tenant','TenantMembership') AND con.contype IN ('p','c')
UNION ALL
SELECT 'fk', con.conname, 0,
       'source_schema=' || src_ns.nspname ||
       ';source=' || src.relname ||
       ';source_columns=' || src_cols.columns ||
       ';target_schema=' || dst_ns.nspname ||
       ';target=' || dst.relname ||
       ';target_columns=' || dst_cols.columns ||
       ';delete=' || CASE con.confdeltype WHEN 'a'::"char" THEN 'NO ACTION'::text WHEN 'r'::"char" THEN 'RESTRICT'::text WHEN 'c'::"char" THEN 'CASCADE'::text WHEN 'n'::"char" THEN 'SET NULL'::text WHEN 'd'::"char" THEN 'SET DEFAULT'::text ELSE format('UNKNOWN:%s', con.confdeltype::text) END ||
       ';update=' || CASE con.confupdtype WHEN 'a'::"char" THEN 'NO ACTION'::text WHEN 'r'::"char" THEN 'RESTRICT'::text WHEN 'c'::"char" THEN 'CASCADE'::text WHEN 'n'::"char" THEN 'SET NULL'::text WHEN 'd'::"char" THEN 'SET DEFAULT'::text ELSE format('UNKNOWN:%s', con.confupdtype::text) END ||
       ';validated=' || con.convalidated::text
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
SELECT 'index', indexname, 0, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('Tenant','TenantMembership')
ORDER BY 1,2,3;
