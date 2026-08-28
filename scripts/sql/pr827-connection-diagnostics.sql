BEGIN TRANSACTION READ ONLY;
SELECT 'TRANSACTION_ACCESS_CLASS', CASE WHEN current_setting('transaction_read_only')='on' THEN 'READ_ONLY' ELSE 'READ_WRITE' END;
SELECT 'CONNECTED_DATABASE_CLASS', CASE WHEN current_database()='salesforce_pro' THEN 'EXPECTED_ALLOWLISTED' ELSE 'UNEXPECTED' END;
SELECT 'CONNECTED_USER_CLASS', CASE WHEN current_user='postgres' THEN 'EXPECTED_ADMIN' ELSE 'UNEXPECTED' END;
SELECT 'CONNECTED_SCHEMA_CLASS', CASE WHEN current_schema()='public' THEN 'PUBLIC' WHEN current_schema() IS NULL THEN 'NONE' ELSE 'OTHER' END;
SELECT 'SEARCH_PATH_CLASS', CASE WHEN (current_schemas(false))[1]='public' THEN 'PUBLIC_FIRST' WHEN 'public'=ANY(current_schemas(false)) THEN 'PUBLIC_INCLUDED' ELSE 'PUBLIC_EXCLUDED' END
FROM (SELECT current_setting('search_path')) observed_search_path;
SELECT 'POSTGRESQL_SERVER_VERSION', current_setting('server_version');
SELECT 'PRISMA_LEDGER_LOCATION', CASE
 WHEN to_regclass('public."_prisma_migrations"') IS NOT NULL THEN 'PUBLIC'
 WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='_prisma_migrations' AND c.relkind IN ('r','p') AND n.nspname<>'public') THEN 'OTHER_SCHEMA_REDACTED'
 ELSE 'ABSENT' END;
SELECT 'PRISMA_LEDGER_SCHEMA_COUNT', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='_prisma_migrations' AND c.relkind IN ('r','p');
SELECT 'PRISMA_LEDGER_VISIBILITY', CASE
 WHEN to_regclass('public."_prisma_migrations"') IS NULL THEN 'NOT_APPLICABLE'
 WHEN has_table_privilege(current_user, 'public."_prisma_migrations"', 'SELECT') THEN 'VISIBLE'
 ELSE 'PERMISSION_DENIED' END;
COMMIT;
