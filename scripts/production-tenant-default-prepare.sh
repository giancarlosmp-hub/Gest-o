#!/usr/bin/env bash
set -euo pipefail
log(){ printf '[production-tenant-default-prepare] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }
: "${EXPECTED_SHA:?EXPECTED_SHA obrigatório}"
: "${MODE:?MODE=dry-run ou MODE=apply obrigatório}"
[[ "$MODE" == dry-run || "$MODE" == apply ]] || die "MODE inválido"
[[ "${TENANCY_MODE:-}" == default-only ]] || die "preparação exige TENANCY_MODE=default-only"
[[ -z "$(git status --porcelain)" ]] || die "worktree não está limpa"
[[ "$(git branch --show-current)" == main ]] || die "branch ativa não é main"
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SHA" && "$(git rev-parse origin/main)" == "$EXPECTED_SHA" ]] || die "SHA Git divergente"
image="gest-o-api:$EXPECTED_SHA"
docker image inspect "$image" >/dev/null 2>&1 || die "imagem API ausente"
label=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ "$label" == "$EXPECTED_SHA" ]] || die "label OCI divergente"
schema_root="${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}/$EXPECTED_SHA"
schema_state="$schema_root/schema-state.tsv"
[[ -s "$schema_state" ]] || die "schema-state PASS ausente"
grep -qx $'post_diff\tempty' "$schema_state" || die "schema-state não comprova equivalência"
grep -qx $'migration\t20260802120000_tenancy_control_plane\tPASS\tb9298218b3c34cdadaf35f31a6d0e8a6e1942e9d1cbf5ae5c77ae305d1cc554d' "$schema_state" || die "control plane não comprovado"
: "${DML_DATABASE_URL:?DML_DATABASE_URL administrativa temporária obrigatória}"
[[ "${DML_DATABASE_URL}" != "${DATABASE_URL:-}" ]] || die "role runtime não pode executar preparação"
db_name=$(DML_DATABASE_URL="$DML_DATABASE_URL" node -e 'const u=new URL(process.env.DML_DATABASE_URL);process.stdout.write(u.pathname.slice(1))')
[[ "$db_name" == salesforce_pro ]] || die "database não autorizado"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?container PostgreSQL esperado obrigatório}"
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED")" == true ]] || die "container PostgreSQL não está running"
if [[ "$MODE" == apply ]]; then
  [[ "${CONFIRM:-}" == PREPARE_DEFAULT_TENANT ]] || die "apply exige CONFIRM=PREPARE_DEFAULT_TENANT"
  bash scripts/production-preflight.sh
fi
root="${TENANCY_EVIDENCE_DIR:-/var/log/gest-o/tenancy}/$EXPECTED_SHA/default-tenant"
install -d -m 700 "$root"
if [[ "$MODE" == apply ]]; then
  dry_manifest="$root/dry-run.PASS.tsv"
  [[ -s "$dry_manifest" ]] || die "dry-run PASS do mesmo SHA ausente"
  dry_hash=$(awk -F'\t' '$1=="gate_hash"{print $2}' "$dry_manifest")
  [[ -n "$dry_hash" ]] || die "manifesto dry-run inválido"
fi
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-$MODE"; run="$root/attempts/$run_id"
install -d -m 700 "$run"
gate="$run/operational-gate.tsv"
printf 'contract\tdefault-tenant-operation-v1\nsha\t%s\nmode\t%s\nnonce\t%s\n' "$EXPECTED_SHA" "$MODE" "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')" >"$gate"
chmod 400 "$gate"; gate_hash=$(sha256sum "$gate" | cut -d' ' -f1)
secret_env=$(mktemp); chmod 600 "$secret_env"; trap 'rm -f "$secret_env"' EXIT
printf 'DATABASE_URL=%s\n' "$DML_DATABASE_URL" >"$secret_env"
args=(--dry-run); [[ "$MODE" == apply ]] && args=(--apply)
docker run --rm --pull=never --network gest-o_default \
  --env-file "$secret_env" -e APP_COMMIT="$EXPECTED_SHA" -e EXPECTED_SHA="$EXPECTED_SHA" \
  -e TENANCY_MODE=default-only -e OPERATIONAL_GATES_VERIFIED=1 \
  -e OPERATIONAL_GATE_FILE=/run/gate.tsv -e OPERATIONAL_GATE_SHA256="$gate_hash" \
  -e EVIDENCE_DIR=/evidence -e CONFIRM="${CONFIRM:-}" \
  -v "$gate:/run/gate.tsv:ro" -v "$run:/evidence" "$image" \
  node apps/api/dist/scripts/prepareDefaultTenant.js "${args[@]}" >"$run/runner.log"
rm -f "$secret_env"; trap - EXIT
[[ -s "$run/result.tsv" ]] || die "runner não emitiu PASS"
result_hash=$(awk -F'\t' 'NR==1{for(i=1;i<=NF;i++)if($i=="aggregateHash")c=i} NR==2{print $c}' "$run/result.tsv")
[[ -n "$result_hash" ]] || die "hash agregado ausente"
if [[ "$MODE" == apply && "$result_hash" != "$dry_hash" ]]; then die "estado relevante mudou desde o dry-run"; fi
manifest="$root/$MODE.PASS.tsv"; [[ ! -e "$manifest" ]] || die "PASS existente não pode ser sobrescrito"
printf 'result\tPASS\nsha\t%s\nimage\t%s\ngate_hash\t%s\nrun\t%s\n' "$EXPECTED_SHA" "$label" "$result_hash" "$run_id" >"$manifest.tmp"
chmod 600 "$manifest.tmp"; mv "$manifest.tmp" "$manifest"
log "$MODE concluído; runtime não foi iniciado nem alterado"
