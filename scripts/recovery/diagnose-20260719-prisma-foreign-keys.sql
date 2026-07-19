\set ON_ERROR_STOP on

-- Read-only diagnosis for Prisma-expected foreign keys before adding NOT VALID constraints.
BEGIN READ ONLY;

CREATE TEMP TABLE _expected_fk(relation_name, child_table, child_column, parent_table, parent_column, on_delete_action, on_update_action) AS
VALUES
  ('Client.ownerSellerId','Client','ownerSellerId','User','id','NO ACTION','NO ACTION'),
  ('Contact.clientId','Contact','clientId','Client','id','NO ACTION','NO ACTION'),
  ('Contact.ownerSellerId','Contact','ownerSellerId','User','id','NO ACTION','NO ACTION'),
  ('Opportunity.clientId','Opportunity','clientId','Client','id','NO ACTION','NO ACTION'),
  ('Opportunity.ownerSellerId','Opportunity','ownerSellerId','User','id','NO ACTION','NO ACTION'),
  ('OpportunityItem.opportunityId','OpportunityItem','opportunityId','Opportunity','id','CASCADE','CASCADE'),
  ('OpportunityItem.productId','OpportunityItem','productId','Product','id','SET NULL','CASCADE'),
  ('ProductPrice.productId','ProductPrice','productId','Product','id','CASCADE','CASCADE'),
  ('ErpOrderSync.opportunityId','ErpOrderSync','opportunityId','Opportunity','id','CASCADE','CASCADE'),
  ('ErpOrderSync.sellerId','ErpOrderSync','sellerId','User','id','RESTRICT','CASCADE'),
  ('Activity.clientId','Activity','clientId','Client','id','NO ACTION','NO ACTION'),
  ('AgendaStop.clientId','AgendaStop','clientId','Client','id','NO ACTION','NO ACTION'),
  ('TimelineEvent.clientId','TimelineEvent','clientId','Client','id','NO ACTION','NO ACTION');

WITH existing AS (
  SELECT con.conname, child.relname AS child_table, child_att.attname AS child_column, parent.relname AS parent_table, parent_att.attname AS parent_column, con.convalidated
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN unnest(con.conkey) WITH ORDINALITY ck(attnum, ord) ON true
  JOIN unnest(con.confkey) WITH ORDINALITY fk(attnum, ord) ON fk.ord = ck.ord
  JOIN pg_attribute child_att ON child_att.attrelid = child.oid AND child_att.attnum = ck.attnum
  JOIN pg_attribute parent_att ON parent_att.attrelid = parent.oid AND parent_att.attnum = fk.attnum
  WHERE con.contype = 'f' AND child.relnamespace = 'public'::regnamespace
)
SELECT e.relation_name, e.child_table, e.child_column, e.parent_table, e.parent_column,
       ex.conname AS existing_constraint, coalesce(ex.convalidated, false) AS existing_validated,
       CASE WHEN ex.conname IS NULL THEN 'missing' WHEN ex.convalidated THEN 'present_validated' ELSE 'present_not_validated' END AS status,
       'Add missing constraints as NOT VALID only after orphan_count = 0; then VALIDATE one constraint at a time.' AS plan
FROM _expected_fk e
LEFT JOIN existing ex USING (child_table, child_column, parent_table, parent_column)
ORDER BY e.child_table, e.child_column;

CREATE TEMP TABLE _orphan_sql AS
SELECT e.*, format('SELECT count(*) FROM public.%I c LEFT JOIN public.%I p ON p.%I = c.%I WHERE c.%I IS NOT NULL AND p.%I IS NULL', child_table, parent_table, parent_column, child_column, child_column, parent_column) AS sql
FROM _expected_fk e;

-- Dynamic orphan counts for every expected relation.
DO $$
DECLARE r record; n bigint;
BEGIN
  CREATE TEMP TABLE _fk_orphan_counts(relation_name text, orphan_count bigint) ON COMMIT DROP;
  FOR r IN SELECT * FROM _orphan_sql LOOP
    EXECUTE r.sql INTO n;
    INSERT INTO _fk_orphan_counts VALUES (r.relation_name, n);
  END LOOP;
END $$;
SELECT * FROM _fk_orphan_counts ORDER BY relation_name;

ROLLBACK;
