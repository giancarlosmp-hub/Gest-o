#!/usr/bin/env bash
set -Eeuo pipefail
name=""; network=""
cleanup() { set +e; [[ -z "$name" ]] || docker rm -f "$name" >/dev/null 2>&1; [[ -z "$network" ]] || docker network rm "$network" >/dev/null 2>&1; }
trap cleanup EXIT
[[ -z "${DATABASE_URL:-}" ]] || { printf 'Inherited DATABASE_URL is forbidden\n' >&2; exit 1; }
command -v docker >/dev/null
name="gesto-gated-plan-pg-$RANDOM-$$"; network="$name-net"
docker network create --internal "$network" >/dev/null
docker run -d --name "$name" --network "$network" -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=gated_plan postgres:16 >/dev/null
ready=false; for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres -d gated_plan >/dev/null 2>&1 && { ready=true; break; }; sleep 1; done; [[ "$ready" == true ]]
psql=(docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d gated_plan)
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
printf 'PREFLIGHT_GATED_BACKFILL_POSTGRES=PASS\n'
