#!/usr/bin/env bash
set -Eeuo pipefail

[[ -z "${DATABASE_URL:-}" ]] || { echo 'Inherited DATABASE_URL is forbidden' >&2; exit 1; }
command -v docker >/dev/null
name="gesto-readiness-pg-$RANDOM-$$"; network="$name-net"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || :; docker network rm "$network" >/dev/null 2>&1 || :; }
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --name "$name" --network "$network" -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=readiness postgres:16 >/dev/null
for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres -d readiness >/dev/null 2>&1 && break; sleep 1; done
psql=(docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d readiness)
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
before=$("${psql[@]}" -At <<'SQL'
SELECT encode(digest(string_agg(v, E'\n' ORDER BY v), 'sha256'),'hex') FROM (
 SELECT 't|'||id||'|'||active v FROM public.tenant UNION ALL SELECT 'u|'||id||'|'||active FROM public.app_user
 UNION ALL SELECT 'm|'||id||'|'||user_id||'|'||tenant_id||'|'||active FROM public.membership
 UNION ALL SELECT 'r|'||root||'|'||id||'|'||coalesce(tenant_id,'NULL')||'|'||coalesce(owner_tenant_id,'NULL')||'|'||parent_exists FROM public.root_fact) s;
SQL
)
result=$("${psql[@]}" -At <<'SQL'
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
[[ "$result" == "BLOCKED_EXPECTED" ]]
after=$("${psql[@]}" -At <<'SQL'
SELECT encode(digest(string_agg(v, E'\n' ORDER BY v), 'sha256'),'hex') FROM (
 SELECT 't|'||id||'|'||active v FROM public.tenant UNION ALL SELECT 'u|'||id||'|'||active FROM public.app_user
 UNION ALL SELECT 'm|'||id||'|'||user_id||'|'||tenant_id||'|'||active FROM public.membership
 UNION ALL SELECT 'r|'||root||'|'||id||'|'||coalesce(tenant_id,'NULL')||'|'||coalesce(owner_tenant_id,'NULL')||'|'||parent_exists FROM public.root_fact) s;
SQL
)
[[ "$before" == "$after" && ${#before} -eq 64 ]]
npm run test:tenant-data-readiness
echo 'TENANT_DATA_READINESS_POSTGRES=PASS'
