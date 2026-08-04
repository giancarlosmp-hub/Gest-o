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
SELECT CASE con.contype WHEN 'p' THEN 'pk' WHEN 'f' THEN 'fk' WHEN 'c' THEN 'check' END,
       con.conname, 0, pg_get_constraintdef(con.oid, true)
FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('Tenant','TenantMembership') AND con.contype IN ('p','f','c')
UNION ALL
SELECT 'index', indexname, 0, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('Tenant','TenantMembership')
ORDER BY 1,2,3;
