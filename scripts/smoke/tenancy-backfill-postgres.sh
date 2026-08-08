#!/usr/bin/env bash
set -eEuo pipefail
HARNESS_STEP=bootstrap
HARNESS_COMMAND='initialize isolated backfill proof'
reported=0
fail(){ local rc=$?; trap - ERR; reported=1; printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND" "$rc" >&2; exit "$rc"; }
step(){ HARNESS_STEP=$1; HARNESS_COMMAND=$2; printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND"; }
trap fail ERR
command -v docker >/dev/null || { printf 'HARNESS_RESULT=SKIP\nEXIT_CODE=77\n'; exit 77; }
docker image inspect postgres:16 >/dev/null 2>&1 || { printf 'HARNESS_RESULT=SKIP\nEXIT_CODE=77\n'; exit 77; }
[[ -z ${PGHOST:-} && -z ${PGSERVICE:-} ]] || { echo 'refusing inherited PostgreSQL destination' >&2; exit 1; }
name="gesto-backfill-$RANDOM-$$"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || :; }
finish(){ local rc=$?; cleanup; if ((rc != 0 && reported == 0)); then printf 'HARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$rc"; fi; }
trap finish EXIT
step postgres_start 'start disposable PostgreSQL 16 without published port'
docker run -d --rm --pull=never --name "$name" -e POSTGRES_PASSWORD=synthetic -e POSTGRES_DB=backfill postgres:16 >/dev/null
for _ in {1..60}; do docker exec "$name" pg_isready -U postgres -d backfill >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" pg_isready -U postgres -d backfill >/dev/null
step fixture_and_ledger 'create synthetic roots and append-only technical ledger'
docker exec -i "$name" psql -X -U postgres -d backfill -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE EXTENSION pgcrypto;
CREATE TABLE tenant(id text PRIMARY KEY, active boolean NOT NULL);
INSERT INTO tenant VALUES ('synthetic-a',true);
CREATE TABLE ledger(run_id uuid PRIMARY KEY, scope text NOT NULL, state text NOT NULL, approved_hash text, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_active_scope ON ledger(scope) WHERE state IN ('planned','dry_run_passed','approved','applying');
CREATE TABLE root_rows(root text NOT NULL,id text NOT NULL,tenant_id text REFERENCES tenant(id),original_tenant text,invalid_reference boolean NOT NULL DEFAULT false,PRIMARY KEY(root,id));
INSERT INTO root_rows(root,id,tenant_id,original_tenant,invalid_reference)
SELECT root,id,tenant_id,tenant_id,invalid FROM unnest(ARRAY['Client','AgendaEvent','Product','AppConfig','Goal','ActivityKPI','Sale','SellerTerritoryCity','KnowledgeDocument','ErpSyncRun','ErpSyncLock']) root
CROSS JOIN (VALUES ('001',NULL::text,false),('002','synthetic-a',false),('003',NULL::text,true)) fixture(id,tenant_id,invalid);
SQL
before=$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows')
step dry_run 'read deterministic keyset plan and prove no DML'
plan_hash=$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c "SELECT encode(digest(string_agg(root||E'\\t'||id||E'\\t'||'synthetic-a',E'\\n' ORDER BY root,id),'sha256'),'hex') FROM root_rows WHERE tenant_id IS NULL AND NOT invalid_reference")
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows')" = "$before"
run_id=00000000-0000-4000-8000-000000000001
[[ $run_id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$ ]]
[[ $plan_hash =~ ^[0-9a-f]{64}$ ]]
docker exec -i "$name" psql -X -U postgres -d backfill -v ON_ERROR_STOP=1 -v run_id="$run_id" -v approved_hash="$plan_hash" <<'SQL' >/dev/null
INSERT INTO ledger(run_id,scope,state,approved_hash)
VALUES (:'run_id'::uuid,'all-roots','dry_run_passed',:'approved_hash');
SQL
ledger_check=$(docker exec -i "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -v run_id="$run_id" -v approved_hash="$plan_hash" <<'SQL'
SELECT count(*)
FROM ledger
WHERE run_id=:'run_id'::uuid
  AND scope='all-roots'
  AND state='dry_run_passed'
  AND approved_hash=:'approved_hash'
  AND length(approved_hash)=64
  AND approved_hash ~ '^[0-9a-f]{64}$';
SQL
)
test "$ledger_check" = 1
step negative_gates 'reject concurrent scope and wrong approved hash'
if docker exec "$name" psql -X -U postgres -d backfill -v ON_ERROR_STOP=1 -c "INSERT INTO ledger VALUES (gen_random_uuid(),'all-roots','planned',NULL,now())" >/dev/null 2>&1; then exit 1; fi
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c "SELECT approved_hash='$plan_hash' FROM ledger WHERE run_id='$run_id'")" = t
step synthetic_apply 'apply only eligible fixtures in bounded keyset batches'
docker exec -i "$name" psql -X -U postgres -d backfill -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
BEGIN;
UPDATE ledger SET state='applying' WHERE run_id='00000000-0000-4000-8000-000000000001' AND state='dry_run_passed';
WITH batch AS (SELECT root,id FROM root_rows WHERE tenant_id IS NULL AND NOT invalid_reference ORDER BY root,id LIMIT 5 FOR UPDATE SKIP LOCKED)
UPDATE root_rows r SET tenant_id='synthetic-a' FROM batch b WHERE (r.root,r.id)=(b.root,b.id) AND r.tenant_id IS NULL;
COMMIT;
SQL
step resume_and_idempotency 'resume remaining batches and prove reapply changes zero rows'
while test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM root_rows WHERE tenant_id IS NULL AND NOT invalid_reference")" != 0; do
  docker exec "$name" psql -X -U postgres -d backfill -v ON_ERROR_STOP=1 -c "WITH batch AS (SELECT root,id FROM root_rows WHERE tenant_id IS NULL AND NOT invalid_reference ORDER BY root,id LIMIT 5) UPDATE root_rows r SET tenant_id='synthetic-a' FROM batch b WHERE (r.root,r.id)=(b.root,b.id) AND r.tenant_id IS NULL" >/dev/null
done
eligible_before_reapply=$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows WHERE tenant_id IS NULL AND NOT invalid_reference')
quarantine_before_reapply=$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows WHERE invalid_reference AND tenant_id IS NULL')
cross_tenant_before_reapply=$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows WHERE original_tenant IS NOT NULL AND tenant_id<>original_tenant')
test "$eligible_before_reapply" = 0
test "$quarantine_before_reapply" = 11
test "$cross_tenant_before_reapply" = 0
reapply_count=$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c "
WITH batch AS (
  SELECT root,id FROM root_rows
  WHERE tenant_id IS NULL AND NOT invalid_reference
  ORDER BY root,id
  LIMIT 5
),
updated AS (
  UPDATE root_rows r SET tenant_id='synthetic-a'
  FROM batch b
  WHERE (r.root,r.id)=(b.root,b.id) AND r.tenant_id IS NULL
  RETURNING 1
)
SELECT count(*) FROM updated;
")
test "$reapply_count" = 0
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows')" = "$before"
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows WHERE tenant_id IS NULL AND NOT invalid_reference')" = 0
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows WHERE invalid_reference AND tenant_id IS NULL')" = 11
step reconciliation 'preserve totals, cross-tenant ownership and formal quarantine'
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows')" = "$before"
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM root_rows WHERE original_tenant IS NOT NULL AND tenant_id<>original_tenant")" = 0
test "$(docker exec "$name" psql -X -U postgres -d backfill -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM root_rows WHERE invalid_reference AND tenant_id IS NULL')" = 11
docker exec "$name" psql -X -U postgres -d backfill -v ON_ERROR_STOP=1 -c "UPDATE ledger SET state='quarantined' WHERE run_id='$run_id'" >/dev/null
printf 'HARNESS_RESULT=PASS\nEXIT_CODE=0\nTENANCY_BACKFILL_TOOLING_POSTGRES=PASS\n'
