\set ON_ERROR_STOP on

-- Incident 2026-07-19: read-only diagnosis for the six restored/validated Prisma foreign keys.
-- Source of expected actions: apps/api/prisma/schema.prisma relation definitions and nullable columns.
-- No TEMP tables are created inside this READ ONLY transaction.

BEGIN READ ONLY;

WITH expected(relation_name, child_table, child_column, parent_table, parent_column, expected_on_delete, expected_on_update, schema_source) AS (VALUES
  ('Activity.clientId','Activity','clientId','Client','id','SET NULL','CASCADE','Activity.clientId is nullable; restored FK uses ON DELETE SET NULL ON UPDATE CASCADE'),
  ('AgendaStop.clientId','AgendaStop','clientId','Client','id','SET NULL','CASCADE','AgendaStop.clientId is nullable; restored FK uses ON DELETE SET NULL ON UPDATE CASCADE'),
  ('Opportunity.clientId','Opportunity','clientId','Client','id','RESTRICT','CASCADE','Opportunity.clientId is required; restored FK uses ON DELETE RESTRICT ON UPDATE CASCADE'),
  ('OpportunityItem.productId','OpportunityItem','productId','Product','id','SET NULL','CASCADE','OpportunityItem.productId is nullable and schema has onDelete: SetNull'),
  ('ProductPrice.productId','ProductPrice','productId','Product','id','CASCADE','CASCADE','ProductPrice.productId is required and schema has onDelete: Cascade'),
  ('TimelineEvent.clientId','TimelineEvent','clientId','Client','id','SET NULL','CASCADE','TimelineEvent.clientId is nullable; restored FK uses ON DELETE SET NULL ON UPDATE CASCADE')
), existing AS (
  SELECT con.conname,
         child.relname AS child_table,
         child_att.attname AS child_column,
         parent.relname AS parent_table,
         parent_att.attname AS parent_column,
         con.convalidated,
         CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS actual_on_delete,
         CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS actual_on_update
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN unnest(con.conkey) WITH ORDINALITY ck(attnum, ord) ON true
  JOIN unnest(con.confkey) WITH ORDINALITY fk(attnum, ord) ON fk.ord = ck.ord
  JOIN pg_attribute child_att ON child_att.attrelid = child.oid AND child_att.attnum = ck.attnum
  JOIN pg_attribute parent_att ON parent_att.attrelid = parent.oid AND parent_att.attnum = fk.attnum
  WHERE con.contype = 'f' AND child_ns.nspname = 'public'
), orphan_counts AS (
  SELECT 'Activity.clientId' AS relation_name, count(*)::int AS orphan_count FROM public."Activity" c LEFT JOIN public."Client" p ON p.id = c."clientId" WHERE c."clientId" IS NOT NULL AND p.id IS NULL
  UNION ALL SELECT 'AgendaStop.clientId', count(*)::int FROM public."AgendaStop" c LEFT JOIN public."Client" p ON p.id = c."clientId" WHERE c."clientId" IS NOT NULL AND p.id IS NULL
  UNION ALL SELECT 'Opportunity.clientId', count(*)::int FROM public."Opportunity" c LEFT JOIN public."Client" p ON p.id = c."clientId" WHERE p.id IS NULL
  UNION ALL SELECT 'OpportunityItem.productId', count(*)::int FROM public."OpportunityItem" c LEFT JOIN public."Product" p ON p.id = c."productId" WHERE c."productId" IS NOT NULL AND p.id IS NULL
  UNION ALL SELECT 'ProductPrice.productId', count(*)::int FROM public."ProductPrice" c LEFT JOIN public."Product" p ON p.id = c."productId" WHERE p.id IS NULL
  UNION ALL SELECT 'TimelineEvent.clientId', count(*)::int FROM public."TimelineEvent" c LEFT JOIN public."Client" p ON p.id = c."clientId" WHERE c."clientId" IS NOT NULL AND p.id IS NULL
)
SELECT e.relation_name,
       e.child_table,
       e.child_column,
       e.parent_table,
       e.parent_column,
       e.expected_on_delete,
       e.expected_on_update,
       ex.conname AS existing_constraint,
       coalesce(ex.convalidated, false) AS existing_validated,
       ex.actual_on_delete,
       ex.actual_on_update,
       coalesce(oc.orphan_count, 0) AS orphan_count,
       CASE
         WHEN ex.conname IS NULL THEN 'missing'
         WHEN NOT ex.convalidated THEN 'present_not_validated'
         WHEN ex.actual_on_delete <> e.expected_on_delete OR ex.actual_on_update <> e.expected_on_update THEN 'action_mismatch'
         WHEN coalesce(oc.orphan_count, 0) <> 0 THEN 'has_orphans'
         ELSE 'restored_validated_ok'
       END AS status,
       e.schema_source
FROM expected e
LEFT JOIN existing ex USING (child_table, child_column, parent_table, parent_column)
LEFT JOIN orphan_counts oc USING (relation_name)
ORDER BY e.relation_name;

COMMIT;
