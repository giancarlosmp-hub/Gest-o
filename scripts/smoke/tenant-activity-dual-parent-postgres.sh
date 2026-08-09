#!/usr/bin/env bash
set -eEuo pipefail
STEP=bootstrap
trap 'rc=$?; printf "ACTIVITY_DUAL_PARENT_STEP=%s\nACTIVITY_DUAL_PARENT_RESULT=FAIL\n" "$STEP" >&2; exit "$rc"' ERR
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
command -v docker >/dev/null || { echo 'SKIP: docker unavailable' >&2; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { echo 'SKIP: postgres:16 unavailable locally' >&2; exit 77; }
[[ -z ${DATABASE_URL:-} && -z ${TEST_DATABASE_URL:-} ]] || { echo 'refusing inherited database URL' >&2; exit 1; }
id="$$-$RANDOM"; pg="gesto-activity-parent-pg-$id"; net="gesto-activity-parent-net-$id"; tmp=$(mktemp -d)
cleanup(){ set +e; docker rm -f "$pg" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1; rm -rf "$tmp"; }
trap cleanup EXIT
checkpoint(){ STEP=$1; printf 'ACTIVITY_DUAL_PARENT_CHECKPOINT=%s\n' "$STEP"; }
psql_exec(){ docker exec -i "$pg" psql -X -U postgres -d proof -v ON_ERROR_STOP=1 "$@"; }
reject_sql(){ local label=$1 sql=$2; if psql_exec -c "$sql" >"$tmp/$label.out" 2>&1; then echo "$label unexpectedly succeeded" >&2; exit 1; fi; }

checkpoint network
docker network create --internal "$net" >/dev/null
docker run -d --rm --pull=never --name "$pg" --network "$net" -e POSTGRES_PASSWORD=redacted -e POSTGRES_DB=proof postgres:16 >/dev/null
for _ in {1..60}; do if docker exec "$pg" pg_isready -U postgres -d proof >/dev/null 2>&1; then break; fi; sleep 1; done
docker exec "$pg" pg_isready -U postgres -d proof >/dev/null

checkpoint predecessor
# Minimal, faithful projection of the real predecessor: real quoted names, types, nullability,
# PKs, indexes and referential actions relevant to Client -> Opportunity -> Activity.
psql_exec <<'SQL' >/dev/null
CREATE TABLE public."Tenant" (id text PRIMARY KEY);
CREATE TABLE public."Client" (id text PRIMARY KEY, "tenantId" text NULL,
  CONSTRAINT "Client_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id));
CREATE INDEX "Client_tenantId_idx" ON public."Client"("tenantId");
CREATE TABLE public."Opportunity" (id text PRIMARY KEY, "clientId" text NOT NULL,
  CONSTRAINT "Opportunity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."Client"(id) ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE TABLE public."Activity" (id text PRIMARY KEY, "clientId" text NULL, "opportunityId" text NULL,
  CONSTRAINT "Activity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."Client"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Activity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES public."Opportunity"(id) ON DELETE SET NULL ON UPDATE CASCADE);
CREATE INDEX "Activity_clientId_idx" ON public."Activity"("clientId");
CREATE INDEX "Activity_opportunityId_idx" ON public."Activity"("opportunityId");
SQL

checkpoint fixtures_before_ddl
psql_exec <<'SQL' >/dev/null
INSERT INTO public."Tenant" VALUES ('tenant-a'),('tenant-b');
INSERT INTO public."Client" VALUES ('client-a1','tenant-a'),('client-a2','tenant-a'),('client-b','tenant-b'),('client-null',NULL);
INSERT INTO public."Opportunity" VALUES ('opportunity-a1','client-a1'),('opportunity-a2','client-a2'),('opportunity-b','client-b'),('opportunity-null','client-null');
INSERT INTO public."Activity" VALUES
 ('only-client','client-a1',NULL), ('only-opportunity',NULL,'opportunity-a1'),
 ('dual-convergent','client-a1','opportunity-a1'),
 ('historical-divergent','client-a1','opportunity-a2'),
 ('historical-cross-tenant','client-a1','opportunity-b'),
 ('orphan-links',NULL,NULL), ('null-tenant-parent','client-null','opportunity-null');
SQL
checkpoint baseline_before_ddl
psql_exec -Atc "SELECT id,\"clientId\",COALESCE(\"opportunityId\",'NULL') FROM public.\"Activity\" ORDER BY id" > "$tmp/baseline.tsv"
test "$(wc -l < "$tmp/baseline.tsv")" = 7
psql_exec -Atc "SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname" > "$tmp/indexes.before"
psql_exec -Atc "SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname" > "$tmp/constraints.before"

checkpoint candidate_ddl
psql_exec < scripts/smoke/sql/activity-dual-parent-candidate.sql >/dev/null
test "$(psql_exec -Atc 'SELECT count(*) FROM public."Activity"')" = 7

checkpoint positive_and_null_proofs
psql_exec <<'SQL' >/dev/null
INSERT INTO public."Activity" VALUES ('new-convergent','client-a1','opportunity-a1');
INSERT INTO public."Activity" VALUES ('new-only-client','client-a2',NULL);
INSERT INTO public."Activity" VALUES ('new-only-opportunity',NULL,'opportunity-a2');
INSERT INTO public."Activity" VALUES ('new-orphan-links',NULL,NULL);
SQL
checkpoint negative_proofs
reject_sql divergent_same_tenant "INSERT INTO public.\"Activity\" VALUES ('bad-same','client-a1','opportunity-a2')"
reject_sql divergent_cross_tenant "INSERT INTO public.\"Activity\" VALUES ('bad-cross','client-a1','opportunity-b')"
reject_sql relink_divergent "UPDATE public.\"Activity\" SET \"opportunityId\"='opportunity-a2' WHERE id='new-convergent'"

checkpoint concurrency
# Two real backends start together. Parent relink conflicts with referenced rows; the Activity
# relink conflicts with the composite key. Neither can commit a divergent state.
cat > "$tmp/parent.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(4242);
UPDATE public."Opportunity" SET "clientId"='client-a2' WHERE id='opportunity-a1';
COMMIT;
SQL
cat > "$tmp/activity.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(4242);
UPDATE public."Activity" SET "clientId"='client-a2' WHERE id='new-convergent';
COMMIT;
SQL
set +e
psql_exec < "$tmp/parent.sql" >"$tmp/parent.out" 2>&1 & p1=$!
psql_exec < "$tmp/activity.sql" >"$tmp/activity.out" 2>&1 & p2=$!
wait "$p1"; r1=$?; wait "$p2"; r2=$?
set -e
test "$r1" -ne 0; test "$r2" -ne 0
test "$(psql_exec -Atc "SELECT count(*) FROM public.\"Activity\" a JOIN public.\"Opportunity\" o ON o.id=a.\"opportunityId\" WHERE a.\"clientId\" IS NOT NULL AND a.\"clientId\"<>o.\"clientId\" AND a.id NOT LIKE 'historical-%'")" = 0

checkpoint catalog
test "$(psql_exec -Atc "SELECT count(*) FROM pg_constraint WHERE conname='Activity_opportunityId_clientId_fkey' AND contype='f' AND NOT convalidated")" = 1
test "$(psql_exec -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='Opportunity_id_clientId_key' AND indexdef LIKE 'CREATE UNIQUE INDEX%'")" = 1

checkpoint rollback_proof
psql_exec -c 'BEGIN; ALTER TABLE public."Activity" DROP CONSTRAINT "Activity_opportunityId_clientId_fkey"; DROP INDEX public."Opportunity_id_clientId_key"; ROLLBACK;' >/dev/null
test "$(psql_exec -Atc "SELECT count(*) FROM pg_constraint WHERE conname='Activity_opportunityId_clientId_fkey'")" = 1

checkpoint post_diff
psql_exec -Atc "SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname" > "$tmp/indexes.after"
psql_exec -Atc "SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname" > "$tmp/constraints.after"
comm -13 "$tmp/indexes.before" "$tmp/indexes.after" > "$tmp/indexes.added"
comm -13 "$tmp/constraints.before" "$tmp/constraints.after" > "$tmp/constraints.added"
test "$(cat "$tmp/indexes.added")" = Opportunity_id_clientId_key
test "$(cat "$tmp/constraints.added")" = Activity_opportunityId_clientId_fkey
echo 'ACTIVITY_DUAL_PARENT_POSTGRES=PASS'
