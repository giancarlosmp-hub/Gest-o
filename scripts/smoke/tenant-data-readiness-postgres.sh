#!/usr/bin/env bash
set -Eeuo pipefail

step=temporary_directory
command_label=initialize
temporary_directory=""
name=""
network=""
checkpoint() { step="$1"; command_label="$1"; printf 'HARNESS_STEP=%s\n' "$step"; }
on_error() {
  local exit_code=$?
  printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=FAIL\nEXIT_CODE=%s\n' "$step" "$command_label" "$exit_code" >&2
  exit "$exit_code"
}
cleanup() {
  set +e
  [[ -z "$name" ]] || docker rm -f "$name" >/dev/null 2>&1
  [[ -z "$network" ]] || docker network rm "$network" >/dev/null 2>&1
  [[ -z "$temporary_directory" ]] || rm -rf "$temporary_directory"
}
trap on_error ERR
trap cleanup EXIT

checkpoint temporary_directory
temporary_directory=$(mktemp -d)
[[ -z "${DATABASE_URL:-}" ]] || { printf 'Inherited DATABASE_URL is forbidden\n' >&2; false; }
command -v docker >/dev/null
name="gesto-readiness-pg-$RANDOM-$$"
network="$name-net"

checkpoint docker_network_setup
docker network create --internal "$network" >/dev/null

checkpoint postgres_start
docker run -d --name "$name" --network "$network" -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=readiness postgres:16 >/dev/null

checkpoint postgres_readiness
postgres_ready=false
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres -d readiness >/dev/null 2>&1; then postgres_ready=true; break; fi
  sleep 1
done
[[ "$postgres_ready" == true ]]
psql=(docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d readiness)

checkpoint fixtures
"${psql[@]}" <<'SQL'
CREATE EXTENSION pgcrypto;
CREATE TABLE public.tenant(id text PRIMARY KEY, active boolean NOT NULL);
CREATE TABLE public.app_user(id text PRIMARY KEY, active boolean NOT NULL);
CREATE TABLE public.membership(id text PRIMARY KEY, user_id text NOT NULL, tenant_id text NOT NULL, active boolean NOT NULL);
CREATE TABLE public.root_fact(root text NOT NULL, id text NOT NULL, tenant_id text, owner_tenant_id text, parent_exists boolean NOT NULL, PRIMARY KEY(root,id));
INSERT INTO public.tenant VALUES ('A',true),('B',false);
INSERT INTO public.app_user VALUES ('active-user',true),('inactive-user',false),('no-membership',true);
INSERT INTO public.membership VALUES ('m-a','active-user','A',true),('m-b','active-user','B',true),('m-suspended','inactive-user','B',false);
INSERT INTO public.root_fact
SELECT root, root || '-ok', 'A', 'A', true FROM unnest(ARRAY['Client','AgendaEvent','Product','AppConfig','Goal','ActivityKPI','Sale','SellerTerritoryCity','KnowledgeDocument','ErpSyncRun','ErpSyncLock']) root;
INSERT INTO public.root_fact VALUES
 ('Client','null',NULL,NULL,true),('AgendaEvent','orphan','A',NULL,false),('Product','cross','A','B',true);
SQL

checkpoint baseline_before
before=$("${psql[@]}" -qAt <<'SQL'
SELECT encode(digest(string_agg(v, E'\n' ORDER BY v), 'sha256'),'hex') FROM (
 SELECT 't|'||id||'|'||active v FROM public.tenant UNION ALL SELECT 'u|'||id||'|'||active FROM public.app_user
 UNION ALL SELECT 'm|'||id||'|'||user_id||'|'||tenant_id||'|'||active FROM public.membership
 UNION ALL SELECT 'r|'||root||'|'||id||'|'||coalesce(tenant_id,'NULL')||'|'||coalesce(owner_tenant_id,'NULL')||'|'||parent_exists FROM public.root_fact) s;
SQL
)
[[ ${#before} -eq 64 && "$before" != *$'\n'* ]]

checkpoint read_only_report
# -q suppresses BEGIN/COMMIT command tags; -A/-t leave exactly the SELECT tuple on stdout.
result=$("${psql[@]}" -qAt <<'SQL'
BEGIN TRANSACTION READ ONLY;
WITH expected(root) AS (SELECT unnest(ARRAY['Client','AgendaEvent','Product','AppConfig','Goal','ActivityKPI','Sale','SellerTerritoryCity','KnowledgeDocument','ErpSyncRun','ErpSyncLock'])),
report AS (SELECT e.root, count(r.*) total, count(r.tenant_id) filled, count(*) FILTER (WHERE r.tenant_id IS NULL) nulls,
 count(DISTINCT r.tenant_id) tenants, count(*) FILTER (WHERE r.tenant_id IS DISTINCT FROM r.owner_tenant_id AND r.tenant_id IS NOT NULL) divergent,
 count(*) FILTER (WHERE NOT r.parent_exists) orphans,
 count(*) FILTER (WHERE r.tenant_id IS NOT NULL AND r.owner_tenant_id IS NOT NULL AND r.tenant_id<>r.owner_tenant_id) cross_tenant,
 encode(digest(coalesce(string_agg(r.id,E'\n' ORDER BY r.id),''),'sha256'),'hex') pk_hash FROM expected e LEFT JOIN public.root_fact r USING(root) GROUP BY e.root)
SELECT CASE WHEN count(*)=11 AND sum(nulls)=1 AND sum(orphans)=1 AND sum(cross_tenant)=1 AND bool_and(length(pk_hash)=64) THEN 'BLOCKED_EXPECTED' ELSE 'FAIL' END FROM report;
COMMIT;
SQL
)
if [[ -z "$result" ]]; then report_line_count=0
else
  report_line_count=1
  remainder="$result"
  while [[ "$remainder" == *$'\n'* ]]; do report_line_count=$((report_line_count + 1)); remainder=${remainder#*$'\n'}; done
fi
if [[ "$report_line_count" -ne 1 || "$result" != "BLOCKED_EXPECTED" ]]; then
  printf 'HARNESS_STEP=read_only_report\nHARNESS_RESULT=FAIL\nHARNESS_LINE_COUNT=%s\nHARNESS_EXPECTED=BLOCKED_EXPECTED\nHARNESS_OBSERVED=%q\n' "$report_line_count" "$result" >&2
  false
fi
printf 'TENANT_DATA_READINESS_REPORT=BLOCKED_EXPECTED\nTENANT_DATA_READINESS_READ_ONLY=PASS\n'

checkpoint baseline_after
after=$("${psql[@]}" -qAt <<'SQL'
SELECT encode(digest(string_agg(v, E'\n' ORDER BY v), 'sha256'),'hex') FROM (
 SELECT 't|'||id||'|'||active v FROM public.tenant UNION ALL SELECT 'u|'||id||'|'||active FROM public.app_user
 UNION ALL SELECT 'm|'||id||'|'||user_id||'|'||tenant_id||'|'||active FROM public.membership
 UNION ALL SELECT 'r|'||root||'|'||id||'|'||coalesce(tenant_id,'NULL')||'|'||coalesce(owner_tenant_id,'NULL')||'|'||parent_exists FROM public.root_fact) s;
SQL
)
[[ ${#after} -eq 64 && "$after" != *$'\n'* && "$before" == "$after" ]]
printf 'TENANT_DATA_READINESS_BASELINE_HASH_MATCH=PASS\n'

checkpoint static_and_unit_gate
npm run test:tenant-data-readiness

checkpoint final
printf 'TENANT_DATA_READINESS_POSTGRES=PASS\n'
