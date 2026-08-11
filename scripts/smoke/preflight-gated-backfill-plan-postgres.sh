#!/usr/bin/env bash
set -Eeuo pipefail
name=""; network=""; tmp="$(mktemp -d)"
HARNESS_STEP=bootstrap; HARNESS_COMMAND='initialize gated plan PostgreSQL harness'; HARNESS_RESULT=RUNNING
cleanup() {
 rc=$?; trap - EXIT INT TERM
 if [[ $rc -ne 0 ]]; then
  printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND" "$rc" >&2
 fi
 set +e
 if [[ -n "$name" ]]; then docker rm -f "$name" >/dev/null 2>&1; fi
 if [[ -n "$network" ]]; then docker network rm "$network" >/dev/null 2>&1; fi
 rm -rf "$tmp"
 exit "$rc"
}
trap cleanup EXIT INT TERM
[[ -z "${DATABASE_URL:-}" && -z "${TEST_DATABASE_URL:-}" ]] || { printf 'Inherited database URLs are forbidden\n' >&2; exit 1; }
command -v docker >/dev/null
name="gesto-gated-plan-pg-$RANDOM-$$"; network="$name-net"
HARNESS_STEP=postgres_start
HARNESS_COMMAND='start disposable postgres 16 container on internal network'
docker network create --internal "$network" >/dev/null
docker run -d --name "$name" --network "$network" -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=gated_plan postgres:16 >/dev/null
psql=(docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d gated_plan)
HARNESS_STEP=database_readiness
HARNESS_COMMAND='wait for gated_plan SQL readiness'
readiness_ready=false
for readiness_attempt in $(seq 1 60); do
 if docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d gated_plan -c 'SELECT 1;' >"$tmp/readiness.out" 2>"$tmp/readiness.err"; then
  readiness_exit=0
 else
  readiness_exit=$?
 fi
 if [[ $readiness_exit -eq 0 && "$(wc -l < "$tmp/readiness.out")" -eq 1 ]] && grep -Fqx '1' "$tmp/readiness.out"; then
  readiness_ready=true
  break
 fi
 sleep 1
done
[[ "$readiness_ready" == true ]]
HARNESS_COMMAND='validate final independent gated_plan SQL connection'
if docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -qAt -U postgres -d gated_plan -c 'SELECT 1;' >"$tmp/readiness-final.out" 2>"$tmp/readiness-final.err"; then
 final_readiness_exit=0
else
 final_readiness_exit=$?
fi
[[ $final_readiness_exit -eq 0 ]]
[[ "$(wc -l < "$tmp/readiness-final.out")" -eq 1 ]]
grep -Fqx '1' "$tmp/readiness-final.out"
HARNESS_RESULT=PASS
printf 'GATED_PLAN_DATABASE_READINESS=PASS\n'
HARNESS_STEP=fixtures
HARNESS_COMMAND='create synthetic gated plan facts after database readiness'
HARNESS_RESULT=RUNNING
"${psql[@]}" >/dev/null <<'SQL'
CREATE EXTENSION pgcrypto;
CREATE TABLE facts(root text NOT NULL, id text NOT NULL, tenant_id text, blocked boolean NOT NULL DEFAULT false, PRIMARY KEY(root,id));
INSERT INTO facts SELECT root, root||'-01', 'tenant-default-v1', false FROM unnest(ARRAY['Client','AgendaEvent','Product','AppConfig','Goal','ActivityKPI','Sale','SellerTerritoryCity','KnowledgeDocument','ErpSyncRun','ErpSyncLock']) root;
SQL
dataset_hash() { "${psql[@]}" -qAtc "SELECT encode(digest(string_agg(root||E'\\t'||id||E'\\t'||coalesce(tenant_id,'NULL')||E'\\t'||blocked,E'\\n' ORDER BY root,id),'sha256'),'hex') FROM facts"; }
before=$(dataset_hash); [[ ${#before} -eq 64 ]]
blocked=$("${psql[@]}" -qAt <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT CASE WHEN bool_or(blocked) OR count(DISTINCT root)<>11 THEN 'PREFLIGHT_GATED_BACKFILL_PLAN=BLOCKED' ELSE 'BLOCKED_FIXTURE_NOT_SELECTED' END FROM (SELECT * FROM facts UNION ALL SELECT 'Client','blocked-row',NULL,true) q;
COMMIT;
SQL
)
[[ "$blocked" == "PREFLIGHT_GATED_BACKFILL_PLAN=BLOCKED" ]]
ready_one=$("${psql[@]}" -qAt <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT encode(digest(string_agg(root||E'\t'||total||E'\t'||nulls||E'\t'||pk_hash,E'\n' ORDER BY root),'sha256'),'hex') FROM (SELECT root,count(*) total,count(*) FILTER(WHERE tenant_id IS NULL) nulls,encode(digest(string_agg(id,E'\n' ORDER BY id),'sha256'),'hex') pk_hash FROM facts GROUP BY root) r HAVING count(*)=11;
COMMIT;
SQL
)
ready_two=$("${psql[@]}" -qAt <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT encode(digest(string_agg(root||E'\t'||total||E'\t'||nulls||E'\t'||pk_hash,E'\n' ORDER BY root),'sha256'),'hex') FROM (SELECT root,count(*) total,count(*) FILTER(WHERE tenant_id IS NULL) nulls,encode(digest(string_agg(id,E'\n' ORDER BY id),'sha256'),'hex') pk_hash FROM facts GROUP BY root ORDER BY root DESC) r HAVING count(*)=11;
COMMIT;
SQL
)
[[ ${#ready_one} -eq 64 && "$ready_one" == "$ready_two" ]]
after=$(dataset_hash); [[ "$before" == "$after" ]]
# The disposable database contains no plan/ledger relation: both outputs above exist only in process memory/stdout.
[[ "$("${psql[@]}" -qAtc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('backfill_plan','backfill_ledger')")" == 0 ]]
npm run test:preflight-gated-backfill-plan
HARNESS_STEP=final
HARNESS_COMMAND='emit gated plan PostgreSQL proof result'
HARNESS_RESULT=PASS
printf 'PREFLIGHT_GATED_BACKFILL_POSTGRES=PASS\n'
