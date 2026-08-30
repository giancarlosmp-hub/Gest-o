BEGIN TRANSACTION READ ONLY;
SELECT kind, name, detail FROM (
 SELECT 'enum' kind, t.typname name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) detail
 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname='public' AND t.typname IN ('ErpOrderManualResolutionCategory','ErpOrderManualResolutionTerminalState') GROUP BY t.typname
 UNION ALL SELECT 'table', c.relname, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ErpOrderManualResolution' AND c.relkind='r'
 UNION ALL SELECT 'column', table_name||'.'||column_name, is_nullable||':'||data_type||':'||udt_name||':'||coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public' AND ((table_name='ErpOrderSync' AND column_name='supersedesErpOrderSyncId') OR table_name='ErpOrderManualResolution')
 UNION ALL SELECT 'pk', c.conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='ErpOrderManualResolution' AND c.contype='p'
 UNION ALL SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname IN ('ErpOrderManualResolution_erpOrderSyncId_key','ErpOrderManualResolution_opportunityId_createdAt_idx','ErpOrderManualResolution_resolvedById_createdAt_idx','ErpOrderSync_supersedesErpOrderSyncId_idx')
 UNION ALL SELECT 'fk', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype='f' AND conname IN ('ErpOrderSync_supersedesErpOrderSyncId_fkey','ErpOrderManualResolution_erpOrderSyncId_fkey','ErpOrderManualResolution_opportunityId_fkey','ErpOrderManualResolution_resolvedById_fkey')
) objects ORDER BY kind,name;
COMMIT;
