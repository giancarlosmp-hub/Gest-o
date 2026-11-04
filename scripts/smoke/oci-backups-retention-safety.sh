#!/usr/bin/env bash
# oci-backups-retention.sh: simulation, apply and every stop, with fictitious
# release folders in a temporary directory and a fake Docker.  The retention
# report is produced by the real release_retention_report.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/oci-backups-retention.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
fail(){ printf 'FALHA: %s\n' "$*" >&2; exit 1; }

cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
# $FAKE_CONTAINERS: one "container_id<TAB>image_id" per line.
printf '%s\n' "$*" >>"$FAKE_CALLS"
case "$1" in
  ps) cut -f1 "$FAKE_CONTAINERS"; exit 0 ;;
  inspect) awk -F'\t' -v c="${*: -1}" '$1==c{print $2; f=1} END{exit !f}' "$FAKE_CONTAINERS"; exit $? ;;
  image) [[ "$2" == ls ]] && exit 0 ;;
esac
printf 'UNEXPECTED %s\n' "$*" >>"$FAKE_CALLS"; exit 99
FAKE
chmod +x "$BIN/docker"
export PATH="$BIN:$PATH" FAKE_CALLS="$TMP/calls" FAKE_CONTAINERS="$TMP/containers.tsv"
RELEASE_ARTIFACT_EXPECTED_OWNER="$(id -un):$(id -gn)"
export RELEASE_ARTIFACT_EXPECTED_OWNER RELEASE_ARTIFACT_ROOT="$TMP/oci-backups" DEPLOY_EVIDENCE_DIR="$TMP/deploy"
export BUILD_EVIDENCE_DIR="$TMP/deploy-builds" REBASELINE_EVIDENCE_DIR="$TMP/rebaseline" RELEASE_RETENTION_REPORT_DIR="$TMP/release-retention"
export OCI_RETENTION_LOG_DIR="$TMP/logs"

commit(){ printf "$1%.0s" {1..40}; }
hexid(){ printf "$1$2%.0s" {1..32}; }  # 64 hex chars
C=(); for n in 1 2 3 4 5; do C[n]=$(commit "$n"); done
id_of(){ printf 'sha256:%s' "$(hexid "$2" "$([[ $1 == api ]] && echo a || echo b)")"; }
release(){ # n role
  local dir="$RELEASE_ARTIFACT_ROOT/${C[$1]}" id; id=$(id_of "$2" "$1")
  local hex=${id#sha256:} tar="$dir/$2.${id#sha256:}.tar.gz"
  mkdir -p "$dir"; chmod 700 "$dir"
  printf 'conteúdo fictício %s\n' "$2" >"$tar"; chmod 600 "$tar"
  printf 'format\t1\nrole\t%s\nimage_id\t%s\nruntime_identity\t%s\nrelease_tag\tgest-o-%s-release:sha256-%s\ncommit\t%s\nbuilt_at\t2020-01-0%sT00:00:00Z\ntar\t%s\ntar_sha256\t%s\ncompression\tgzip-1\nreleased_at\t2020-01-0%sT00:00:00Z\n' \
    "$2" "$id" "$id" "$2" "$hex" "${C[$1]}" "$1" "$tar" "$(sha256sum "$tar" | cut -d' ' -f1)" "$1" >"$dir/$2.$hex.release.tsv"
  chmod 600 "$dir/$2.$hex.release.tsv"
}
cutover(){ # current_n rollback_n
  local ev="$DEPLOY_EVIDENCE_DIR/${C[$1]}" r=$2 role
  mkdir -p "$ev"; : >"$ev/index.local.html"
  printf 'role\trollback_mode\tcontainer_name\tcontainer_id\truntime_identity\trollback_reference\tport\tnetworks\trestart_policy\tprevious_commit\tresolution_method\tartifact_id\n' >"$ev/previous-runtime.tsv"
  printf 'role\timage_id\trelease_tag\ttar\ttar_sha256\n' >"$ev/rollback-artifacts.tsv"
  for role in api web; do
    printf '%s\timage\tc\tcid\t%s\t%s\t1\tn\tunless-stopped\t%s\truntime-identity\t%s\n' "$role" "$(id_of $role "$r")" "$(id_of $role "$r")" "${C[$r]}" "$(id_of $role "$r")" >>"$ev/previous-runtime.tsv"
    printf '%s\t%s\tt\t%s\tx\n' "$role" "$(id_of $role "$r")" "$RELEASE_ARTIFACT_ROOT/${C[$r]}/$role.$(hexid "$r" "$([[ $role == api ]] && echo a || echo b)").tar.gz" >>"$ev/rollback-artifacts.tsv"
  done
}
report(){ # real report from the library, in a subshell
  ( # shellcheck source=scripts/lib/production-release-artifact.sh
    source "$ROOT/scripts/lib/production-release-artifact.sh"; release_retention_report >/dev/null )
  REPORT=$(ls "$RELEASE_RETENTION_REPORT_DIR"/*.tsv | tail -n1)
}
reset(){
  rm -rf "${TMP:?}/oci-backups" "${TMP:?}/deploy" "${TMP:?}/deploy-builds" "${TMP:?}/rebaseline" "${TMP:?}/release-retention" "${TMP:?}/logs"
  mkdir -p "$RELEASE_ARTIFACT_ROOT" "$BUILD_EVIDENCE_DIR"; chmod 700 "$RELEASE_ARTIFACT_ROOT"; : >"$FAKE_CALLS"
  for n in 1 2 3 4 5; do release "$n" api; release "$n" web; done
  # Rebaseline folder (no .release.tsv) and a folder with an unverifiable record.
  mkdir -p "$RELEASE_ARTIFACT_ROOT/$(commit e)"; printf 'legado\n' >"$RELEASE_ARTIFACT_ROOT/$(commit e)/gest-o-api.tar"
  C[6]=$(commit f); release 6 api; sed -i 's/^released_at\t.*/released_at\t2020-01-01T00:00:00Z/' "$RELEASE_ARTIFACT_ROOT/${C[6]}"/*.release.tsv; chmod 644 "$RELEASE_ARTIFACT_ROOT/${C[6]}"/*.release.tsv
  cutover 5 4
  printf 'c5api\t%s\nc5web\t%s\n' "$(id_of api 5)" "$(id_of web 5)" >"$FAKE_CONTAINERS"
  report
}
run(){ set +e; OUT=$(bash "$SCRIPT" "$@" 2>"$TMP/stderr"); RC=$?; set -e; }
snapshot(){ find "$RELEASE_ARTIFACT_ROOT" -printf '%p %s\n' | LC_ALL=C sort; }
plan_of(){ grep "OCI_RETENTION_PLAN dir=$1 " <<<"$OUT" || fail "pasta ausente do plano: $1"; }
expect_stop(){ local reason=$1 before; shift; before=$(snapshot); run "$@"
  [[ "$RC" -eq 1 ]] && grep -q "OCI_RETENTION_RESULT=STOPPED reason=$reason mutations=0" <<<"$OUT" || fail "esperado $reason: $OUT"
  [[ "$(snapshot)" == "$before" ]] || fail "$reason alterou arquivos"; }
candidates(){ grep -o 'OCI_RETENTION_PLAN dir=[0-9a-f]* decision=candidate' <<<"$OUT" | cut -d= -f2 | cut -d' ' -f1 | LC_ALL=C sort | paste -sd, -; }

# --- Simulation: C1..C3 are the only candidates. ---
reset; before=$(snapshot); run
[[ "$RC" -eq 0 ]] || fail "simulação: $OUT"
[[ "$(candidates)" == "${C[1]},${C[2]},${C[3]}" ]] || fail "candidatas: $(candidates)"
plan_of "${C[5]}" | grep -q 'reason=.*recent_1.*in_use.*current' || fail 'pasta atual'
plan_of "${C[4]}" | grep -q 'current_rollback' || fail 'pasta de rollback'
plan_of "$(commit e)" | grep -q 'no_release_record' || fail 'pasta de rebaseline'
plan_of "${C[6]}" | grep -q 'unverifiable_record' || fail 'registro inverificável'
grep -q 'OCI_RETENTION_RESULT=SIMULATED candidates=3 mutations=0' <<<"$OUT" || fail 'resultado da simulação'
[[ "$(snapshot)" == "$before" ]] || fail 'simulação alterou arquivos'
compgen -G "$OCI_RETENTION_LOG_DIR/*.log" >/dev/null || fail 'log ausente'

# --- Apply: removes exactly those folders, file by file. ---
reset; run --apply --expect=3
[[ "$RC" -eq 0 ]] || fail "apply: $OUT"
for n in 1 2 3; do [[ ! -e "$RELEASE_ARTIFACT_ROOT/${C[$n]}" ]] || fail "C$n não removida"; done
for n in 4 5 6; do [[ -n "$(ls -A "$RELEASE_ARTIFACT_ROOT/${C[$n]}")" ]] || fail "C$n tocada"; done
[[ -f "$RELEASE_ARTIFACT_ROOT/$(commit e)/gest-o-api.tar" ]] || fail 'rebaseline tocado'
grep -q 'OCI_RETENTION_RESULT=APPLIED removed_dirs=3 mutations=15' <<<"$OUT" || fail "resultado do apply: $OUT"
if grep -q UNEXPECTED "$FAKE_CALLS"; then fail "docker inesperado: $(cat "$FAKE_CALLS")"; fi

# --- Stops. ---
reset; expect_stop expect_mismatch --apply --expect=2
reset; expect_stop expect_mismatch --apply --expect=4
reset; mv "$REPORT" "$RELEASE_RETENTION_REPORT_DIR/20190101T000000Z.tsv"; expect_stop report_stale --apply --expect=3
reset; rm "$REPORT"; expect_stop report_missing --apply --expect=3
reset; rm "$DEPLOY_EVIDENCE_DIR/${C[5]}/previous-runtime.tsv"; expect_stop rollback_set_unreadable --apply --expect=3

# --- Current rollback moved to C2 after the report: still protected. ---
reset; rm -r "${DEPLOY_EVIDENCE_DIR:?}/${C[5]}"; cutover 5 2
expect_stop expect_mismatch --apply --expect=3
run; plan_of "${C[2]}" | grep -q 'decision=keep reason=current_rollback' || fail "rollback atual: $OUT"
# A tar listed only in rollback-artifacts.tsv is protected too.
reset; printf 'api\t%s\tt\t%s\tx\n' "$(id_of api 2)" "$RELEASE_ARTIFACT_ROOT/${C[2]}/api.$(hexid 2 a).tar.gz" >>"$DEPLOY_EVIDENCE_DIR/${C[5]}/rollback-artifacts.tsv"
run; plan_of "${C[2]}" | grep -q 'decision=keep reason=current_rollback' || fail "tar do rollback-artifacts: $OUT"

# --- Image in use, pending build, report not superseded, extra file. ---
reset; printf 'c3old\t%s\n' "$(id_of web 3)" >>"$FAKE_CONTAINERS"
run; plan_of "${C[3]}" | grep -q 'decision=keep reason=in_use' || fail "imagem em uso: $OUT"
reset; mkdir -p "$BUILD_EVIDENCE_DIR/${C[1]}"; printf 'recorded_at\t2020-02-01T00:00:00Z\napi_image_id\t%s\n' "$(id_of api 1)" >"$BUILD_EVIDENCE_DIR/${C[1]}/build.tsv"
run; plan_of "${C[1]}" | grep -q 'decision=keep reason=build_pending' || fail "build pendente: $OUT"
reset; sed -i "/\/${C[2]}\/web\./s/\twould_delete\tsuperseded$/\tkeep\trecent_9/" "$REPORT"
run; plan_of "${C[2]}" | grep -q 'decision=keep reason=not_superseded_in_report' || fail "relatório: $OUT"
reset; printf 'nota\n' >"$RELEASE_ARTIFACT_ROOT/${C[3]}/notes.txt"
run; plan_of "${C[3]}" | grep -q 'decision=keep reason=unexpected_file' || fail "arquivo extra: $OUT"
reset; rm "$RELEASE_ARTIFACT_ROOT/${C[3]}"/web.*.tar.gz
run; plan_of "${C[3]}" | grep -q 'unpaired_file' || fail "par incompleto: $OUT"

# --- Usage errors. ---
reset; before=$(snapshot)
for args in "--apply" "--apply --expect=0" "--expect=3 --force" "-rf"; do
  # shellcheck disable=SC2086
  run $args; [[ "$RC" -eq 2 ]] || fail "uso inválido aceito: $args"
done
[[ "$(snapshot)" == "$before" ]] || fail 'uso inválido alterou arquivos'

# --- Static: no recursive or forced removal, no Docker mutation. ---
if grep -nE 'rm -r|rm -f|rm -rf|--force|docker (rmi|tag|image rm|system|volume|container rm)|prune' "$SCRIPT"; then fail 'comando proibido'; fi
printf 'OCI_BACKUPS_RETENTION_SAFETY=PASS\n'
