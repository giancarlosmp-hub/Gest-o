#!/usr/bin/env bash
set -Eeuo pipefail

VALIDATION_VERSION="1"
IMAGE="postgres:16"
TIMEOUT_SECONDS="${RESTORE_TIMEOUT_SECONDS:-180}"
EVIDENCE_ROOT="${RESTORE_EVIDENCE_ROOT:-/tmp/gest-o-restore-evidence}"
TEST_ID="${RESTORE_TEST_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM}"
SAFE_ID="$(printf '%s' "$TEST_ID" | tr -cd 'A-Za-z0-9_.-' | cut -c1-48)"
NETWORK="gesto-restore-net-$SAFE_ID"
SOURCE_CONTAINER="gesto-restore-source-$SAFE_ID"
TARGET_CONTAINER="gesto-restore-target-$SAFE_ID"
TARGET_DB="gesto_restore_$RANDOM"
ADMIN_USER="restore_admin"
ADMIN_PASSWORD="synthetic-only-$RANDOM-$RANDOM"
EVIDENCE_DIR="$EVIDENCE_ROOT/$TEST_ID"
TEMP_DIR=""
CREATED_NETWORK=0
CREATED_SOURCE=0
CREATED_TARGET=0

log(){ printf '[backup-restore-smoke] %s\n' "$*" >&2; }
die(){ log "ERRO: $*"; exit 1; }
cleanup(){
  set +e
  (( CREATED_SOURCE == 0 )) || docker rm -f "$SOURCE_CONTAINER" >/dev/null 2>&1
  (( CREATED_TARGET == 0 )) || docker rm -f "$TARGET_CONTAINER" >/dev/null 2>&1
  (( CREATED_NETWORK == 0 )) || docker network rm "$NETWORK" >/dev/null 2>&1
  [[ -z "$TEMP_DIR" ]] || rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT ERR INT TERM

command -v docker >/dev/null 2>&1 || { log 'SKIP: Docker não está disponível'; exit 77; }
docker info >/dev/null 2>&1 || { log 'SKIP: daemon Docker não está disponível'; exit 77; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "SKIP: $IMAGE não está local; --pull=never impede download"; exit 77; }
for inherited in DATABASE_URL PRODUCTION_DB_HOST_EXPECTED PRODUCTION_DB_CONTAINER_EXPECTED PRODUCTION_DB_VOLUME_EXPECTED; do
  [[ -z "${!inherited:-}" ]] || die "variável externa proibida presente: $inherited"
done
[[ "$TARGET_DB" != "salesforce"'_pro' ]] || die 'nome de database reservado'
[[ "$NETWORK" != "gest-o"'_default' ]] || die 'rede reservada'
[[ "$TARGET_CONTAINER" != "gest-o-db-clean-v2-"'20260717' ]] || die 'container reservado'
[[ "$NETWORK" == gesto-restore-net-* && "$TARGET_CONTAINER" == gesto-restore-target-* ]] || die 'identidade descartável inválida'
[[ "$TARGET_DB" == gesto_restore_* ]] || die 'database descartável inválido'
[[ "$NETWORK" != *localhost* && "$NETWORK" != *127.0.0.1* ]] || die 'hostname externo proibido'

mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gesto-restore-$SAFE_ID.XXXXXX")"
BACKUP_FILE="${1:-${BACKUP_FILE:-}}"
CHECKSUM_FILE="${BACKUP_SHA256_FILE:-}"

docker network create --internal "$NETWORK" >/dev/null
CREATED_NETWORK=1

start_postgres(){
  local name="$1" db="$2"
  docker run -d --pull=never --name "$name" --network "$NETWORK" --restart=no \
    -e POSTGRES_USER="$ADMIN_USER" -e POSTGRES_PASSWORD="$ADMIN_PASSWORD" -e POSTGRES_DB="$db" \
    --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=512m "$IMAGE" >/dev/null
}
wait_ready(){
  local name="$1" db="$2" i
  for i in $(seq 1 "$TIMEOUT_SECONDS"); do
    docker exec "$name" pg_isready -U "$ADMIN_USER" -d "$db" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "timeout aguardando PostgreSQL descartável"
}

if [[ -z "$BACKUP_FILE" ]]; then
  SOURCE_DB="gesto_source_$RANDOM"
  start_postgres "$SOURCE_CONTAINER" "$SOURCE_DB"; CREATED_SOURCE=1; wait_ready "$SOURCE_CONTAINER" "$SOURCE_DB"
  docker exec -i "$SOURCE_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$ADMIN_USER" -d "$SOURCE_DB" >/dev/null <<'SQL'
CREATE TYPE public.incident_level AS ENUM ('INFO','WARN');
CREATE TABLE public.restore_parent (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL);
CREATE TABLE public.restore_child (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.restore_parent(id), state public.incident_level NOT NULL);
CREATE INDEX restore_child_parent_idx ON public.restore_child(parent_id);
CREATE TABLE public.incident_synthetic (id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public._prisma_migrations (id varchar(36) PRIMARY KEY, migration_name varchar(255) NOT NULL);
INSERT INTO public.restore_parent(label) VALUES ('fixture-a'),('fixture-b');
INSERT INTO public.restore_child(parent_id,state) VALUES (1,'INFO'),(2,'WARN');
INSERT INTO public.incident_synthetic(id) VALUES (1);
INSERT INTO public._prisma_migrations(id,migration_name) VALUES ('00000000-0000-0000-0000-000000000001','synthetic_restore_fixture');
SQL
  BACKUP_FILE="$TEMP_DIR/synthetic.dump"
  docker exec "$SOURCE_CONTAINER" pg_dump -U "$ADMIN_USER" -d "$SOURCE_DB" --format=custom --no-owner --no-acl >"$BACKUP_FILE"
  CHECKSUM_FILE="$BACKUP_FILE.sha256"
  (cd "$TEMP_DIR" && sha256sum "$(basename "$BACKUP_FILE")" >"$(basename "$CHECKSUM_FILE")")
fi

[[ -f "$BACKUP_FILE" && -r "$BACKUP_FILE" ]] || die 'arquivo de backup inexistente ou não legível'
[[ -n "$CHECKSUM_FILE" ]] || CHECKSUM_FILE="$BACKUP_FILE.sha256"
[[ -f "$CHECKSUM_FILE" && -r "$CHECKSUM_FILE" ]] || die 'checksum obrigatório ausente'
(cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(realpath --relative-to="$(dirname "$BACKUP_FILE")" "$CHECKSUM_FILE")" >/dev/null) || die 'checksum SHA256 inválido'
BACKUP_SHA256="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
BACKUP_SIZE="$(stat -c %s "$BACKUP_FILE")"

start_postgres "$TARGET_CONTAINER" "$TARGET_DB"; CREATED_TARGET=1; wait_ready "$TARGET_CONTAINER" "$TARGET_DB"
docker exec -i "$TARGET_CONTAINER" pg_restore --list <"$BACKUP_FILE" >"$EVIDENCE_DIR/pg-restore-list.txt" || die 'formato ou catálogo pg_restore incompatível'
[[ -s "$EVIDENCE_DIR/pg-restore-list.txt" ]] || die 'catálogo vazio'
printf '%s  %s\n' "$BACKUP_SHA256" "$(basename "$BACKUP_FILE")" >"$EVIDENCE_DIR/backup.sha256"
PG_RESTORE_VERSION="$(docker exec "$TARGET_CONTAINER" pg_restore --version | tr '\t\n' ' ')"
printf 'timestamp_utc\tbackup_size_bytes\tbackup_sha256\tpg_restore_version\n%s\t%s\t%s\t%s\n' \
  "$(date -u +%FT%TZ)" "$BACKUP_SIZE" "$BACKUP_SHA256" "$PG_RESTORE_VERSION" >"$EVIDENCE_DIR/pre-restore.tsv"
printf 'test_id\tnetwork_isolated\tports_published\tstorage\n%s\tyes\tno\ttmpfs\n' "$TEST_ID" >"$EVIDENCE_DIR/restore-metadata.tsv"

RESTORE_STARTED_EPOCH="$(date +%s)"; RESTORE_STARTED_AT="$(date -u +%FT%TZ)"
timeout "$TIMEOUT_SECONDS" docker exec -i "$TARGET_CONTAINER" pg_restore \
  --exit-on-error --single-transaction --no-owner --no-acl -U "$ADMIN_USER" -d "$TARGET_DB" \
  <"$BACKUP_FILE" >"$EVIDENCE_DIR/restore.stdout.log" 2>"$EVIDENCE_DIR/restore.stderr.log" || die 'restore falhou fechado'

query(){ docker exec "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$ADMIN_USER" -d "$TARGET_DB" -Atc "$1"; }
[[ "$(query 'SELECT 1')" == 1 ]] || die 'primeira conexão falhou'
[[ "$(query "SELECT count(*) FROM pg_namespace WHERE nspname='public'")" == 1 ]] || die 'schema public ausente'
TABLES="$(query "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")"
[[ "$TABLES" -gt 0 ]] || die 'nenhuma tabela restaurada'
CONSTRAINTS="$(query "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace")"
FOREIGN_KEYS="$(query "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f'")"
INDEXES="$(query "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace")"
ENUMS="$(query "SELECT count(DISTINCT t.oid) FROM pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typtype='e'")"
PRISMA_MIGRATIONS="$(query "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='_prisma_migrations'")"
query "SELECT relname || E'\\t' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I','public',relname),false,true,'')))[1]::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND relname LIKE 'incident\\_%' ESCAPE '\\' ORDER BY relname" >"$EVIDENCE_DIR/incident-tables.tsv"
printf 'metric\tcount\ntables\t%s\nconstraints\t%s\nforeign_keys\t%s\nindexes\t%s\nenums\t%s\nprisma_migrations_table\t%s\n' "$TABLES" "$CONSTRAINTS" "$FOREIGN_KEYS" "$INDEXES" "$ENUMS" "$PRISMA_MIGRATIONS" >"$EVIDENCE_DIR/object-counts.tsv"
query "SELECT c.relname || E'\\t' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I','public',c.relname),false,true,'')))[1]::text FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') ORDER BY c.relname" >"$EVIDENCE_DIR/post-restore.tsv"

VERIFY_DUMP="$TEMP_DIR/verified.dump"
docker exec "$TARGET_CONTAINER" pg_dump -U "$ADMIN_USER" -d "$TARGET_DB" --format=custom --no-owner --no-acl >"$VERIFY_DUMP"
docker exec -i "$TARGET_CONTAINER" pg_restore --list <"$VERIFY_DUMP" >/dev/null || die 'catálogo do dump pós-restore ilegível'
[[ "$(query 'SELECT 1')" == 1 ]] || die 'segunda conexão falhou'
printf '%s\n' '-- SKIP: Prisma diff requer imagem API pinada explicitamente e não foi inferida.' >"$EVIDENCE_DIR/prisma-diff.sql"

RESTORE_FINISHED_EPOCH="$(date +%s)"; RESTORE_FINISHED_AT="$(date -u +%FT%TZ)"
POSTGRES_VERSION="$(query 'SHOW server_version')"
printf 'check\tresult\nconnection\tPASS\npublic_schema\tPASS\nobjects\tPASS\nredump_catalog\tPASS\nsecond_connection\tPASS\n' >"$EVIDENCE_DIR/post-conditions.tsv"
# result.tsv is deliberately the final evidence file and exists only after every validation passed.
printf 'timestamp_utc\ttest_id\tbackup_sha256\tpostgres_version\trestore_started_at\trestore_finished_at\tduration_seconds\tresult\tvalidation_version\n%s\t%s\t%s\t%s\t%s\t%s\t%s\tPASS\t%s\n' \
  "$(date -u +%FT%TZ)" "$TEST_ID" "$BACKUP_SHA256" "$POSTGRES_VERSION" "$RESTORE_STARTED_AT" "$RESTORE_FINISHED_AT" "$((RESTORE_FINISHED_EPOCH-RESTORE_STARTED_EPOCH))" "$VALIDATION_VERSION" >"$EVIDENCE_DIR/result.tsv"
log "PASS: ensaio descartável concluído; evidência metadatal em $EVIDENCE_DIR"
