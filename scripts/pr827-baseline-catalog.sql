BEGIN TRANSACTION READ ONLY;
WITH required(table_name,column_name,data_type) AS (VALUES
 ('ErpOrderSync','id','text'),('Opportunity','id','text'),('User','id','text')
), columns AS (
 SELECT r.*, c.is_nullable, c.data_type AS actual_type
 FROM required r LEFT JOIN information_schema.columns c
   ON c.table_schema='public' AND c.table_name=r.table_name AND c.column_name=r.column_name
), keys AS (
 SELECT r.table_name, EXISTS (
   SELECT 1 FROM pg_constraint k
   JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='public' AND t.relname=r.table_name AND k.contype IN ('p','u')
     AND k.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=t.oid AND attname='id')]::smallint[]
 ) key_ok FROM required r
), role_type AS (
 SELECT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE n.nspname='public' AND t.typname='Role' AND t.typtype='e') ok
)
SELECT 'PR827_BASELINE_CATALOG_STATE', CASE
 WHEN (SELECT count(*) FROM columns WHERE actual_type=data_type AND is_nullable='NO')=3
      AND (SELECT bool_and(key_ok) FROM keys)
      AND (SELECT ok FROM role_type) THEN 'VALID' ELSE 'INVALID' END;
COMMIT;
