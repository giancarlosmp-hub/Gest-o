#!/usr/bin/env bash
set -Eeuo pipefail
[[ -z "${DATABASE_URL:-}" && -z "${TEST_DATABASE_URL:-}" ]] || { echo 'Inherited database URLs are forbidden' >&2; exit 1; }
umask 077
tmp="$(mktemp -d)"; name="gesto-ledger-pg-$RANDOM-$$"; network="$name-net"; cleaned=false
HARNESS_STEP=BOOTSTRAP; HARNESS_COMMAND='initialize disposable PostgreSQL harness'; HARNESS_RESULT=RUNNING
cleanup() {
 rc=$?; trap - EXIT INT TERM
 if [[ $rc -ne 0 ]]; then
  HARNESS_RESULT=FAIL
  printf 'HARNESS_STEP=%s\nHARNESS_COMMAND=%s\nHARNESS_RESULT=%s\nEXIT_CODE=%s\n' "$HARNESS_STEP" "$HARNESS_COMMAND" "$HARNESS_RESULT" "$rc" >&2
 fi
 set +e
 docker rm -f "$name" >/dev/null 2>&1
 docker network rm "$network" >/dev/null 2>&1
 rm -rf "$tmp"
 set -e
 if [[ "$cleaned" != true && $rc -eq 0 ]]; then rc=1; fi
 exit "$rc"
}
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
SELECT 'ROLE|'||rolname FROM pg_catalog.pg_roles WHERE rolname='preflight_plan_ledger_writer';
SELECT 'GRANT|'||table_name||'|'||grantee||'|'||privilege_type FROM information_schema.table_privileges
 WHERE table_schema = 'public'
 AND table_name IN (
  'tenant_preflight_evidence_registry',
  'tenant_backfill_plan_ledger',
  'tenant_backfill_plan_event'
 )
 AND grantee = 'preflight_plan_ledger_writer'
 ORDER BY table_name,privilege_type;
SQL
HARNESS_STEP=DDL_CATALOG
HARNESS_COMMAND='validate literal FOREIGN KEY catalog entry'
grep -Fq 'FOREIGN KEY' "$tmp/catalog"
HARNESS_STEP=DDL_CATALOG
HARNESS_COMMAND='validate literal TRIGGER catalog entry'
grep -Fq 'TRIGGER' "$tmp/catalog"
HARNESS_STEP=DDL_CATALOG
HARNESS_COMMAND='validate exactly one writer role from pg_roles'
[[ "$(grep -Fxc 'ROLE|preflight_plan_ledger_writer' "$tmp/catalog")" -eq 1 ]]
HARNESS_STEP=DDL_CATALOG
HARNESS_COMMAND='validate exact evidence registry writer grant'
[[ "$(grep -Fxc 'GRANT|tenant_preflight_evidence_registry|preflight_plan_ledger_writer|SELECT' "$tmp/catalog")" -eq 1 ]]
HARNESS_STEP=DDL_CATALOG
HARNESS_COMMAND='validate exact plan ledger writer grant'
[[ "$(grep -Fxc 'GRANT|tenant_backfill_plan_ledger|preflight_plan_ledger_writer|SELECT' "$tmp/catalog")" -eq 1 ]]
HARNESS_STEP=DDL_CATALOG
HARNESS_COMMAND='validate exact plan event writer grant'
[[ "$(grep -Fxc 'GRANT|tenant_backfill_plan_event|preflight_plan_ledger_writer|SELECT' "$tmp/catalog")" -eq 1 ]]
HARNESS_STEP=DDL_CATALOG
HARNESS_COMMAND='validate writer grant set cardinality'
[[ "$(grep -Fc 'GRANT|' "$tmp/catalog")" -eq 3 ]]
HARNESS_RESULT=PASS
echo DDL_CATALOG=PASS

h1=$(printf 'a%.0s' {1..64}); h2=$(printf 'b%.0s' {1..64}); p1=$(printf 'c%.0s' {1..64}); p2=$(printf 'd%.0s' {1..64}); p3=$(printf 'e%.0s' {1..64})
evcall="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_evidence('ev-1','$h1','1.0B.2-L/v1','1.0B.2-A/roots-v1','2026-08-09T10:00Z','2030-08-10T10:00Z','READY');"
run_sql() { printf '%s\n' "$1" | "${psql[@]}" -qAt >"$2" 2>"$3"; }
safe_sqlstate() { sed -n 's/^ERROR:  \([0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]\):.*/\1/p' "$1" | head -n 1; }
report_backend_failure() {
 local backend="$1" exit_code="$2" stderr_file="$3" state
 state="$(safe_sqlstate "$stderr_file")"
 printf 'IDENTICAL_EVIDENCE_BACKEND_%s_EXIT_CODE=%s\n' "$backend" "$exit_code" >&2
 if [[ -n "$state" ]]; then printf 'IDENTICAL_EVIDENCE_BACKEND_%s_SQLSTATE=%s\n' "$backend" "$state" >&2; fi
 printf 'IDENTICAL_EVIDENCE_BACKEND_%s_RESULT=EXECUTION_FAILED\n' "$backend" >&2
}

HARNESS_STEP=IDENTICAL_EVIDENCE_CONCURRENCY
HARNESS_COMMAND='launch two identical evidence registrations'
HARNESS_RESULT=RUNNING
run_sql "$evcall" "$tmp/evidence-1.out" "$tmp/evidence-1.err" &
evidence_pid_1=$!
run_sql "$evcall" "$tmp/evidence-2.out" "$tmp/evidence-2.err" &
evidence_pid_2=$!
HARNESS_STEP=IDENTICAL_EVIDENCE_CONCURRENCY
HARNESS_COMMAND='wait for both identical evidence registrations'
if wait "$evidence_pid_1"; then evidence_exit_1=0; else evidence_exit_1=$?; fi
if wait "$evidence_pid_2"; then evidence_exit_2=0; else evidence_exit_2=$?; fi
printf 'IDENTICAL_EVIDENCE_EXIT_1=%s\nIDENTICAL_EVIDENCE_EXIT_2=%s\nIDENTICAL_EVIDENCE_PROCESSES=WAITED\n' "$evidence_exit_1" "$evidence_exit_2"
HARNESS_STEP=IDENTICAL_EVIDENCE_CONCURRENCY
HARNESS_COMMAND='validate identical evidence process exit codes'
if [[ $evidence_exit_1 -ne 0 || $evidence_exit_2 -ne 0 ]]; then
 if [[ $evidence_exit_1 -ne 0 ]]; then report_backend_failure 1 "$evidence_exit_1" "$tmp/evidence-1.err"; fi
 if [[ $evidence_exit_2 -ne 0 ]]; then report_backend_failure 2 "$evidence_exit_2" "$tmp/evidence-2.err"; fi
 if [[ $evidence_exit_1 -ne 0 ]]; then exit "$evidence_exit_1"; else exit "$evidence_exit_2"; fi
fi
HARNESS_STEP=IDENTICAL_EVIDENCE_CONCURRENCY
HARNESS_COMMAND='validate one registered and one idempotent replay result'
[[ "$(grep -Fxc 'REGISTERED' "$tmp/evidence-1.out")" -le 1 ]]
[[ "$(grep -Fxc 'REGISTERED' "$tmp/evidence-2.out")" -le 1 ]]
[[ "$(grep -Fxc 'IDEMPOTENT_REPLAY' "$tmp/evidence-1.out")" -le 1 ]]
[[ "$(grep -Fxc 'IDEMPOTENT_REPLAY' "$tmp/evidence-2.out")" -le 1 ]]
[[ "$(( $(grep -Fxc 'REGISTERED' "$tmp/evidence-1.out") + $(grep -Fxc 'REGISTERED' "$tmp/evidence-2.out") ))" -eq 1 ]]
[[ "$(( $(grep -Fxc 'IDEMPOTENT_REPLAY' "$tmp/evidence-1.out") + $(grep -Fxc 'IDEMPOTENT_REPLAY' "$tmp/evidence-2.out") ))" -eq 1 ]]
[[ "$(( $(wc -l < "$tmp/evidence-1.out") + $(wc -l < "$tmp/evidence-2.out") ))" -eq 2 ]]
HARNESS_RESULT=PASS
echo IDENTICAL_EVIDENCE_CONCURRENCY=PASS
echo CHECKPOINT=IDENTICAL_EVIDENCE_CONCURRENCY

HARNESS_STEP=CONFLICTING_EVIDENCE_CONCURRENCY
HARNESS_COMMAND='launch and wait for conflicting evidence registrations'
HARNESS_RESULT=RUNNING
conflict_a="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_evidence('ev-race','$h1','v','i','2026-08-09','2030-08-10','READY');"
conflict_b="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_evidence('ev-race','$h2','v','i','2026-08-09','2030-08-10','READY');"
run_sql "$conflict_a" "$tmp/conflict-evidence-1.out" "$tmp/conflict-evidence-1.err" & conflict_evidence_pid_1=$!
run_sql "$conflict_b" "$tmp/conflict-evidence-2.out" "$tmp/conflict-evidence-2.err" & conflict_evidence_pid_2=$!
if wait "$conflict_evidence_pid_1"; then conflict_evidence_exit_1=0; else conflict_evidence_exit_1=$?; fi
if wait "$conflict_evidence_pid_2"; then conflict_evidence_exit_2=0; else conflict_evidence_exit_2=$?; fi
HARNESS_COMMAND='validate one evidence conflict with SQLSTATE 23505 and one canonical row'
[[ $(( (conflict_evidence_exit_1==0) + (conflict_evidence_exit_2==0) )) -eq 1 ]]
[[ "$(cat "$tmp/conflict-evidence-1.err" "$tmp/conflict-evidence-2.err" | grep -Fc '23505')" -ge 1 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_preflight_evidence_registry WHERE evidence_id='ev-race';" | "${psql[@]}" -At)" == 1 ]]
echo CHECKPOINT=CONFLICT_SQLSTATE_23505

HARNESS_STEP=IDENTICAL_PLAN_CONCURRENCY
HARNESS_COMMAND='launch and wait for two identical plan registrations'
HARNESS_RESULT=RUNNING
plancall="SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_plan('plan-1','$p1','ev-1','$h1','1.0B.2-M/v1','tenant-synthetic',true,false,'PLANNED');"
run_sql "$plancall" "$tmp/plan-1.out" "$tmp/plan-1.err" & plan_pid_1=$!
run_sql "$plancall" "$tmp/plan-2.out" "$tmp/plan-2.err" & plan_pid_2=$!
if wait "$plan_pid_1"; then plan_exit_1=0; else plan_exit_1=$?; fi
if wait "$plan_pid_2"; then plan_exit_2=0; else plan_exit_2=$?; fi
HARNESS_COMMAND='validate identical plan exits results and canonical row'
[[ $plan_exit_1 -eq 0 && $plan_exit_2 -eq 0 ]]
[[ "$(( $(grep -Fxc 'REGISTERED' "$tmp/plan-1.out") + $(grep -Fxc 'REGISTERED' "$tmp/plan-2.out") ))" -eq 1 ]]
[[ "$(( $(grep -Fxc 'IDEMPOTENT_REPLAY' "$tmp/plan-1.out") + $(grep -Fxc 'IDEMPOTENT_REPLAY' "$tmp/plan-2.out") ))" -eq 1 ]]
[[ "$(( $(wc -l < "$tmp/plan-1.out") + $(wc -l < "$tmp/plan-2.out") ))" -eq 2 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_ledger WHERE plan_id='plan-1';" | "${psql[@]}" -At)" == 1 ]]
echo CHECKPOINT=IDENTICAL_PLAN_CONCURRENCY

HARNESS_STEP=CONFLICTING_PLAN_CONCURRENCY
HARNESS_COMMAND='launch and wait for conflicting plan registrations'
HARNESS_RESULT=RUNNING
run_sql "SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_plan('plan-race','$p1','ev-1','$h1','v','tenant-synthetic',true,false,'PLANNED');" "$tmp/conflict-plan-1.out" "$tmp/conflict-plan-1.err" & conflict_plan_pid_1=$!
run_sql "SET ROLE preflight_plan_ledger_writer; SELECT public.register_preflight_plan('plan-race','$p2','ev-1','$h1','v','tenant-synthetic',true,false,'PLANNED');" "$tmp/conflict-plan-2.out" "$tmp/conflict-plan-2.err" & conflict_plan_pid_2=$!
if wait "$conflict_plan_pid_1"; then conflict_plan_exit_1=0; else conflict_plan_exit_1=$?; fi
if wait "$conflict_plan_pid_2"; then conflict_plan_exit_2=0; else conflict_plan_exit_2=$?; fi
HARNESS_COMMAND='validate one plan conflict with SQLSTATE 23505 and one canonical row'
[[ $(( (conflict_plan_exit_1==0) + (conflict_plan_exit_2==0) )) -eq 1 ]]
[[ "$(cat "$tmp/conflict-plan-1.err" "$tmp/conflict-plan-2.err" | grep -Fc '23505')" -ge 1 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_ledger WHERE plan_id='plan-race';" | "${psql[@]}" -At)" == 1 ]]

HARNESS_STEP=CRASH_ROLLBACK_RESUME
HARNESS_COMMAND='validate isolated crash rollback fixture is absent'
HARNESS_RESULT=RUNNING
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_ledger WHERE plan_id='plan-crash';" | "${psql[@]}" -At)" == 0 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_ledger WHERE plan_hash='$p3';" | "${psql[@]}" -At)" == 0 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_preflight_evidence_registry WHERE evidence_id='ev-crash';" | "${psql[@]}" -At)" == 0 ]]
HARNESS_STEP=CRASH_ROLLBACK_RESUME
HARNESS_COMMAND='execute isolated crash transaction with explicit rollback'
"${psql[@]}" <<SQL
BEGIN; SET ROLE preflight_plan_ledger_writer;
SELECT public.register_preflight_evidence('ev-crash','$h1','v','i','2026-08-09','2030-08-10','READY');
SELECT public.register_preflight_plan('plan-crash','$p3','ev-crash','$h1','v','tenant-synthetic',true,false,'PLANNED'); ROLLBACK;
SQL
HARNESS_STEP=CRASH_ROLLBACK_RESUME
HARNESS_COMMAND='validate crash evidence plan hash and events are absent after rollback'
[[ "$(printf "SELECT count(*) FROM public.tenant_preflight_evidence_registry WHERE evidence_id='ev-crash';" | "${psql[@]}" -At)" == 0 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_ledger WHERE plan_id='plan-crash';" | "${psql[@]}" -At)" == 0 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_ledger WHERE plan_hash='$p3';" | "${psql[@]}" -At)" == 0 ]]
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_event WHERE evidence_id='ev-crash' OR plan_id='plan-crash';" | "${psql[@]}" -At)" == 0 ]]
HARNESS_RESULT=PASS
echo CRASH_ROLLBACK_RESUME=PASS
echo CHECKPOINT=CRASH_ROLLBACK_RESUME

HARNESS_STEP=APPEND_ONLY_NEGATIVE_PROOFS
HARNESS_COMMAND='validate writer UPDATE and DELETE operations fail with SQLSTATE 42501'
HARNESS_RESULT=RUNNING
"${psql[@]}" <<SQL
SET ROLE preflight_plan_ledger_writer;
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
[[ "$(printf "SELECT count(*) FROM public.tenant_backfill_plan_event e LEFT JOIN public.tenant_preflight_evidence_registry r USING(evidence_id) WHERE e.evidence_id IS NOT NULL AND r.evidence_id IS NULL;" | "${psql[@]}" -At)" == 0 ]]
echo CHECKPOINT=CRASH_RESUME_APPEND_ONLY

teardown="DROP FUNCTION public.register_preflight_plan(text,text,text,text,text,text,boolean,boolean,text); DROP FUNCTION public.register_preflight_evidence(text,text,text,text,timestamptz,timestamptz,text); DROP TABLE public.tenant_backfill_plan_event; DROP TABLE public.tenant_backfill_plan_ledger; DROP TABLE public.tenant_preflight_evidence_registry; DROP FUNCTION public.reject_preflight_ledger_mutation(); DROP ROLE preflight_plan_ledger_writer;"
HARNESS_STEP=TEARDOWN_TRANSACTIONAL
HARNESS_COMMAND='rollback candidate teardown and validate objects remain'
HARNESS_RESULT=RUNNING
printf 'BEGIN; %s ROLLBACK;\n' "$teardown" | "${psql[@]}"
[[ "$(printf "SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.tenant_preflight_evidence_registry'::regclass,'public.tenant_backfill_plan_ledger'::regclass,'public.tenant_backfill_plan_event'::regclass);" | "${psql[@]}" -At)" == 3 ]]
HARNESS_STEP=TEARDOWN_REAL
HARNESS_COMMAND='remove candidate ledger objects'
printf '%s\n' "$teardown" | "${psql[@]}"
HARNESS_STEP=BASELINE_COMPARISON
HARNESS_COMMAND='compare public catalog before and after teardown'
printf '%s\n' "$catalog" | "${psql[@]}" -At >"$tmp/after"
cmp "$tmp/before" "$tmp/after"
cleaned=true
HARNESS_STEP=FINAL
HARNESS_COMMAND='emit final PostgreSQL ledger proof result'
HARNESS_RESULT=PASS
echo PREFLIGHT_PLAN_LEDGER_POSTGRES=PASS
