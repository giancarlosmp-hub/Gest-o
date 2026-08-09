#!/usr/bin/env bash
set -Eeuo pipefail
[[ -z "${DATABASE_URL:-}" && -z "${TEST_DATABASE_URL:-}" ]] || { echo 'Inherited database URLs are forbidden' >&2; exit 1; }
umask 077
tmp="$(mktemp -d)"; name="gesto-ledger-pg-$RANDOM-$$"; network="$name-net"; cleaned=false
cleanup() { rc=$?; trap - EXIT INT TERM; docker rm -f "$name" >/dev/null 2>&1 || :; docker network rm "$network" >/dev/null 2>&1 || :; rm -rf "$tmp"; $cleaned || rc=1; exit "$rc"; }
trap cleanup EXIT INT TERM
docker network create --internal "$network" >/dev/null
docker run -d --name "$name" --network "$network" -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=ledger postgres:16 >/dev/null
for _ in $(seq 1 60); do if docker exec "$name" pg_isready -U postgres -d ledger >/dev/null 2>&1; then break; fi; sleep 1; done
docker exec "$name" pg_isready -U postgres -d ledger >/dev/null
psql=(docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -U postgres -d ledger)
catalog="SELECT c.relkind,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1,2,3;"
printf '%s\n' "$catalog" | "${psql[@]}" -At >"$tmp/before"
"${psql[@]}" < scripts/smoke/sql/preflight-plan-ledger-candidate.sql
echo CHECKPOINT=DDL_CATALOG
"${psql[@]}" -At <<'SQL' >"$tmp/catalog"
SELECT 'CONSTRAINT|'||conrelid::regclass||'|'||conname||'|'||pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('public.tenant_preflight_evidence_registry'::regclass,'public.tenant_backfill_plan_ledger'::regclass,'public.tenant_backfill_plan_event'::regclass) ORDER BY 1;
SELECT 'TRIGGER|'||event_object_table||'|'||trigger_name FROM information_schema.triggers WHERE event_object_schema='public' ORDER BY 1;
SELECT 'GRANT|'||table_name||'|'||grantee||'|'||privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name LIKE 'tenant_%ledger%' OR table_name='tenant_preflight_evidence_registry' ORDER BY 1;
SQL
rg -q 'FOREIGN KEY' "$tmp/catalog"; rg -q 'TRIGGER' "$tmp/catalog"; rg -q 'preflight_plan_ledger_writer' "$tmp/catalog"

h1=$(printf 'a%.0s' {1..64}); h2=$(printf 'b%.0s' {1..64}); p1=$(printf 'c%.0s' {1..64}); p2=$(printf 'd%.0s' {1..64})
evcall="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_evidence('ev-1','$h1','1.0B.2-L/v1','1.0B.2-A/roots-v1','2026-08-09T10:00Z','2030-08-10T10:00Z','READY');"
run_sql() { printf '%s\n' "$1" | "${psql[@]}" >"$2" 2>"$3"; }
run_sql "$evcall" "$tmp/e1.out" "$tmp/e1.err" & a=$!; run_sql "$evcall" "$tmp/e2.out" "$tmp/e2.err" & b=$!
set +e; wait "$a"; ea=$?; wait "$b"; eb=$?; set -e
[[ $ea -eq 0 && $eb -eq 0 ]]; grep -q REGISTERED "$tmp/e1.out" "$tmp/e2.out"; grep -q IDEMPOTENT_REPLAY "$tmp/e1.out" "$tmp/e2.out"
echo CHECKPOINT=IDENTICAL_EVIDENCE_CONCURRENCY

conflict_a="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_evidence('ev-race','$h1','v','i','2026-08-09','2030-08-10','READY');"
conflict_b="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_evidence('ev-race','$h2','v','i','2026-08-09','2030-08-10','READY');"
run_sql "$conflict_a" "$tmp/c1.out" "$tmp/c1.err" & a=$!; run_sql "$conflict_b" "$tmp/c2.out" "$tmp/c2.err" & b=$!
set +e; wait "$a"; ea=$?; wait "$b"; eb=$?; set -e
[[ $(( (ea==0) + (eb==0) )) -eq 1 ]]; cat "$tmp/c1.err" "$tmp/c2.err" | grep -q '23505'
echo CHECKPOINT=CONFLICT_SQLSTATE_23505

plancall="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_plan('plan-1','$p1','ev-1','$h1','1.0B.2-M/v1','tenant-synthetic',true,false,'PLANNED');"
run_sql "$plancall" "$tmp/p1.out" "$tmp/p1.err" & a=$!; run_sql "$plancall" "$tmp/p2.out" "$tmp/p2.err" & b=$!
set +e; wait "$a"; ea=$?; wait "$b"; eb=$?; set -e; [[ $ea -eq 0 && $eb -eq 0 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_ledger WHERE plan_id='plan-1';" | "${psql[@]}" -At)" == 1 ]]
echo CHECKPOINT=IDENTICAL_PLAN_CONCURRENCY

run_sql "SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_plan('plan-race','$p1','ev-1','$h1','v','tenant-synthetic',true,false,'PLANNED');" "$tmp/r1.out" "$tmp/r1.err" & a=$!
run_sql "SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_plan('plan-race','$p2','ev-1','$h1','v','tenant-synthetic',true,false,'PLANNED');" "$tmp/r2.out" "$tmp/r2.err" & b=$!
set +e; wait "$a"; ea=$?; wait "$b"; eb=$?; set -e; [[ $(( (ea==0) + (eb==0) )) -eq 1 ]]; cat "$tmp/r1.err" "$tmp/r2.err" | grep -q 23505

"${psql[@]}" <<SQL
BEGIN; SET ROLE preflight_plan_ledger_writer;
SELECT public.register_preflight_evidence('ev-crash','$h1','v','i','2026-08-09','2030-08-10','READY');
SELECT public.register_preflight_plan('plan-crash','$p2','ev-crash','$h1','v','tenant-synthetic',true,false,'PLANNED'); ROLLBACK;
DO \$\$DECLARE s text; BEGIN
 BEGIN UPDATE public.tenant_preflight_evidence_registry SET evidence_hash='$h2' WHERE evidence_id='ev-1'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN DELETE FROM public.tenant_preflight_evidence_registry WHERE evidence_id='ev-1'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN UPDATE public.tenant_backfill_plan_ledger SET plan_hash='$p2' WHERE plan_id='plan-1'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN UPDATE public.tenant_backfill_plan_ledger SET evidence_id='x' WHERE plan_id='plan-1'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN UPDATE public.tenant_backfill_plan_ledger SET apply_authorized=true WHERE plan_id='plan-1'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN UPDATE public.tenant_backfill_plan_ledger SET dry_run_only=false WHERE plan_id='plan-1'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN DELETE FROM public.tenant_backfill_plan_ledger WHERE plan_id='plan-1'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN DELETE FROM public.tenant_backfill_plan_event; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
 BEGIN UPDATE public.tenant_backfill_plan_event SET event_type='CONFLICT_REJECTED'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; IF s<>'42501' THEN RAISE EXCEPTION 'unexpected %',s; END IF; END;
END\$\$;
SQL
[[ "$(printf "SELECT count(*) FROM public.tenant_preflight_evidence_registry WHERE evidence_id='ev-crash';" | "${psql[@]}" -At)" == 0 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_event e LEFT JOIN public.tenant_preflight_evidence_registry r USING(evidence_id) WHERE e.evidence_id IS NOT NULL AND r.evidence_id IS NULL;" | "${psql[@]}" -At)" == 0 ]]
echo CHECKPOINT=CRASH_RESUME_APPEND_ONLY

teardown="DROP FUNCTION public.register_preflight_plan(text,text,text,text,text,text,boolean,boolean,text); DROP FUNCTION public.register_preflight_evidence(text,text,text,text,timestamptz,timestamptz,text); DROP TABLE public.tenant_backfill_plan_event; DROP TABLE public.tenant_backfill_plan_ledger; DROP TABLE public.tenant_preflight_evidence_registry; DROP FUNCTION public.reject_preflight_ledger_mutation(); DROP ROLE preflight_plan_ledger_writer;"
printf 'BEGIN; %s ROLLBACK;\n' "$teardown" | "${psql[@]}"; printf '%s\n' "$teardown" | "${psql[@]}"
printf '%s\n' "$catalog" | "${psql[@]}" -At >"$tmp/after"; cmp "$tmp/before" "$tmp/after"
cleaned=true
echo PREFLIGHT_PLAN_LEDGER_POSTGRES=PASS
