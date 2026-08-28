BEGIN TRANSACTION READ ONLY;
SELECT checksum, finished_at IS NOT NULL AND rolled_back_at IS NULL
FROM public."_prisma_migrations"
WHERE migration_name = :'migration_name'
ORDER BY started_at;
COMMIT;
