#!/usr/bin/env bash
set -euo pipefail

# Formal Production Rebaseline Script
#
# Creates an authorized rebaseline record for target OCI images when legacy
# runtime image identity cannot be verified for rollback.  The runtime serving
# ports 4000/5173 is detected and recorded per role (legacy_runtime_<role>_*).
#
# Requirements:
# - Requires CONFIRM=PRODUCTION_REBASELINE_APPROVED
# - Requires EXPECTED_SHA matching current git HEAD
# - Requires clean git worktree
# - Validates local OCI presence and org.opencontainers.image.revision label of gest-o-api:$EXPECTED_SHA and gest-o-web:$EXPECTED_SHA
# - Generates OCI image tarball backups via docker save (without container snapshotting)
# - Records rebaseline evidence in REBASELINE_EVIDENCE_DIR (/var/log/gest-o/rebaseline/$EXPECTED_SHA)
# - Never stops, deletes, or modifies running containers
# - Never executes cutover

APP_DIR="${APP_DIR:-/apps/gest-o}"
REBASELINE_EVIDENCE_DIR="${REBASELINE_EVIDENCE_DIR:-/var/log/gest-o/rebaseline}"
OCI_BACKUP_DIR="${OCI_BACKUP_DIR:-/var/log/gest-o/oci-backups}"

log() { printf '[production-rebaseline] %s\n' "$*"; }
die() { log "ERRO: $*" >&2; exit 1; }

printf 'REBASELINE_SCRIPT_ENTERED=PASS\n'

if [[ "${CONFIRM:-}" != "PRODUCTION_REBASELINE_APPROVED" ]]; then
  die "Rebaseline exige confirmação explícita CONFIRM=PRODUCTION_REBASELINE_APPROVED"
fi

if [[ ! "${EXPECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  die "EXPECTED_SHA ausente ou em formato inválido (exigido hash SHA-1 de 40 caracteres hexadecimais)"
fi

if [[ -d "$APP_DIR" ]]; then
  cd "$APP_DIR"
fi

if actual_head=$(git rev-parse HEAD 2>/dev/null); then
  if [[ "$actual_head" != "$EXPECTED_SHA" ]]; then
    die "EXPECTED_SHA ($EXPECTED_SHA) difere do HEAD do repositório ($actual_head)"
  fi
fi

if worktree_status=$(git status --porcelain 2>/dev/null); [[ -n "$worktree_status" ]]; then
  die "Working tree não está limpa em $APP_DIR. Abortando rebaseline."
fi

API_IMAGE="${API_IMAGE:-gest-o-api:$EXPECTED_SHA}"
WEB_IMAGE="${WEB_IMAGE:-gest-o-web:$EXPECTED_SHA}"

log "Validando existência e rótulos OCI das imagens alvo: $API_IMAGE e $WEB_IMAGE"

for img in "$API_IMAGE" "$WEB_IMAGE"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    die "Imagem OCI alvo $img não encontrada localmente no Docker Engine"
  fi
  rev=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img" 2>/dev/null || true)
  if [[ "$rev" != "$EXPECTED_SHA" ]]; then
    die "Imagem OCI alvo $img possui rótulo org.opencontainers.image.revision ($rev) diferente de $EXPECTED_SHA"
  fi
done

api_id=$(docker image inspect --format '{{.Id}}' "$API_IMAGE")
web_id=$(docker image inspect --format '{{.Id}}' "$WEB_IMAGE")

if [[ ! "$api_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  die "ID da imagem API inválido: $api_id"
fi

if [[ ! "$web_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  die "ID da imagem WEB inválido: $web_id"
fi

tsv_value() { printf '%s' "$1" | tr -d '\t\r\n'; }

# Record the runtime actually serving each role, using the same port-owner
# criterion as the cutover inventory.  Nothing about the legacy artifact is
# assumed: identity and commit are read from the running container.
legacy_runtime_records=""
for spec in api:4000 web:5173; do
  role=${spec%%:*}; port=${spec##*:}
  owners=$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$2~p{print $1}')
  [[ "$(printf '%s\n' "$owners" | sed '/^$/d' | wc -l)" -eq 1 ]] || die "porta $port não possui proprietário único; runtime atual de $role não identificado"
  legacy_container_id=$(docker inspect -f '{{.Id}}' "$owners" 2>/dev/null) || die "não foi possível inspecionar o container $owners de $role"
  legacy_identity=$(docker inspect -f '{{.Image}}' "$legacy_container_id")
  legacy_config_image=$(docker inspect -f '{{.Config.Image}}' "$legacy_container_id")
  legacy_commit=""
  if docker image inspect "$legacy_identity" >/dev/null 2>&1; then
    legacy_inspectable=yes
    legacy_commit=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$legacy_identity" 2>/dev/null || true)
  else
    legacy_inspectable=no
  fi
  [[ -n "$legacy_commit" && "$legacy_commit" != '<no value>' ]] || legacy_commit=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$legacy_container_id" | sed -n 's/^APP_COMMIT=//p' | head -1)
  legacy_commit=${legacy_commit:-unknown}
  log "runtime atual role=$role container=$legacy_container_id identity=$legacy_identity config_image=$legacy_config_image commit=$legacy_commit inspectable=$legacy_inspectable"
  legacy_runtime_records+=$(printf 'legacy_runtime_%s_container_id\t%s\nlegacy_runtime_%s_identity\t%s\nlegacy_runtime_%s_config_image\t%s\nlegacy_runtime_%s_commit\t%s\nlegacy_runtime_%s_inspectable\t%s' \
    "$role" "$(tsv_value "$legacy_container_id")" "$role" "$(tsv_value "$legacy_identity")" "$role" "$(tsv_value "$legacy_config_image")" \
    "$role" "$(tsv_value "$legacy_commit")" "$role" "$legacy_inspectable")$'\n'
  if [[ "$legacy_inspectable" == no ]]; then
    legacy_runtime_records+=$(printf 'unavailable_legacy_%s_artifact\t%s (%s)\nunavailable_legacy_%s_reason\truntime_image_not_inspectable_in_local_engine' \
      "$role" "$(tsv_value "$legacy_commit")" "$(tsv_value "$legacy_identity")" "$role")$'\n'
  fi
done

api_digest=$(docker image inspect --format '{{if .Descriptor}}{{.Descriptor.Digest}}{{else}}{{.Id}}{{end}}' "$API_IMAGE" 2>/dev/null || echo "$api_id")
web_digest=$(docker image inspect --format '{{if .Descriptor}}{{.Descriptor.Digest}}{{else}}{{.Id}}{{end}}' "$WEB_IMAGE" 2>/dev/null || echo "$web_id")

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Persist OCI Tarball Image Backups (docker save)
oci_target_dir="$OCI_BACKUP_DIR/$EXPECTED_SHA"
mkdir -p -m 700 "$oci_target_dir" || die "Falha ao criar diretório OCI backup: $oci_target_dir"

api_tar="$oci_target_dir/gest-o-api.tar"
web_tar="$oci_target_dir/gest-o-web.tar"

log "Exportando backup OCI persistente via docker save para $oci_target_dir"
docker save "$API_IMAGE" -o "$api_tar" || die "Falha ao exportar backup OCI de $API_IMAGE"
docker save "$WEB_IMAGE" -o "$web_tar" || die "Falha ao exportar backup OCI de $WEB_IMAGE"

chmod 600 "$api_tar" "$web_tar"

api_tar_sha=$(sha256sum "$api_tar" | cut -d' ' -f1)
web_tar_sha=$(sha256sum "$web_tar" | cut -d' ' -f1)

# Record Rebaseline Evidence Bundle
evidence_dir="$REBASELINE_EVIDENCE_DIR/$EXPECTED_SHA"
mkdir -p -m 700 "$evidence_dir" || die "Falha ao criar diretório de evidência de rebaseline: $evidence_dir"

result_file="$evidence_dir/result.tsv"
manifest_file="$evidence_dir/manifest.tsv"

{
  printf 'result\tPASS\n'
  printf 'rebaseline_commit\t%s\n' "$EXPECTED_SHA"
  printf 'rebaselined_at\t%s\n' "$timestamp"
  printf 'api_image_tag\t%s\n' "$API_IMAGE"
  printf 'api_image_id\t%s\n' "$api_id"
  printf 'api_image_digest\t%s\n' "$api_digest"
  printf 'api_tar_path\t%s\n' "$api_tar"
  printf 'api_tar_sha256\t%s\n' "$api_tar_sha"
  printf 'web_image_tag\t%s\n' "$WEB_IMAGE"
  printf 'web_image_id\t%s\n' "$web_id"
  printf 'web_image_digest\t%s\n' "$web_digest"
  printf 'web_tar_path\t%s\n' "$web_tar"
  printf 'web_tar_sha256\t%s\n' "$web_tar_sha"
  printf '%s' "$legacy_runtime_records"
  printf 'cutover_executed\tNO\n'
} > "$result_file"

chmod 600 "$result_file"

{
  printf 'role\timage_tag\timage_id\tdigest\ttar_path\ttar_sha256\n'
  printf 'api\t%s\t%s\t%s\t%s\t%s\n' "$API_IMAGE" "$api_id" "$api_digest" "$api_tar" "$api_tar_sha"
  printf 'web\t%s\t%s\t%s\t%s\t%s\n' "$WEB_IMAGE" "$web_id" "$web_digest" "$web_tar" "$web_tar_sha"
} > "$manifest_file"

chmod 600 "$manifest_file"

log "Rebaseline concluído com sucesso para SHA $EXPECTED_SHA"
log "Evidência gravada em $result_file"
log "Backup OCI gerado em $oci_target_dir"
log "Nenhum container foi parado, removido ou alterado. Cutover NÃO foi executado."

printf 'REBASELINE_COMPLETED=PASS\n'
