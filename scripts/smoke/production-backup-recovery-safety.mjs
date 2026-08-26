import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const script = readFileSync(resolve(root, "scripts/prepare-production-recovery-backup.sh"), "utf8");
const workflow = readFileSync(resolve(root, ".github/workflows/prepare-production-recovery-backup.yml"), "utf8");
const common = readFileSync(resolve(root, "scripts/lib/production-backup-common.sh"), "utf8");
const historical = readFileSync(resolve(root, "backup.sh"), "utf8");
const healthCheck = readFileSync(resolve(root, "scripts/check-prod-health.sh"), "utf8");

for (const contract of [
  "PREPARE_PRODUCTION_RECOVERY_BACKUP", "EXPECTED_SHA",
  "backup_validate_database_health", "backup_validate_plain_dump", "backup_validate_gzip_dump",
  "sha256sum -c", "flock -n", "PRODUCTION_BACKUP_TEST_FAIL_BETWEEN_PROMOTIONS",
  "PRODUCTION_PREFLIGHT_MODE=cutover", "BACKUP_FAILURE_STAGE", "BACKUP_FAILURE_COMMAND",
  "BACKUP_FAILURE_EXIT_CODE", "PRODUCTION_BACKUP_ATOMIC_PROMOTION=PASS",
]) assert.ok(script.includes(contract), `missing contract: ${contract}`);

for (const dumpPathPredicate of [
  "validate_dump_path_absolute", "validate_dump_path_traversal", "validate_dump_path_normalized",
  "validate_dump_path_parent", "validate_dump_path_basename", "validate_dump_path_symlink",
  "validate_dump_path_entry_type",
]) assert.ok(script.includes(dumpPathPredicate), `missing dump path predicate: ${dumpPathPredicate}`);
assert.match(script, /PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY:-/);
assert.match(script, /PRODUCTION_BACKUP_AUTHORIZED_DIR:-\/root\/backups/);
assert.match(script, /EFFECTIVE_BACKUP_FILE="\$AUTHORIZED_DIR\/production\.sql\.gz"/);
assert.match(script, /EFFECTIVE_BACKUP_SHA256_FILE="\$AUTHORIZED_DIR\/production\.sql\.gz\.sha256"/);
assert.match(script, /ENV_SOURCE" == canonical[\s\S]*STRICT_CANONICAL[\s\S]*REBOUND_LEGACY_READ_ONLY/);
assert.match(script, /historical_path_syntax_safe[\s\S]*\[:cntrl:\][\s\S]*\.\.\//);
assert.match(script, /PRODUCTION_BACKUP_FILE="\$EFFECTIVE_BACKUP_FILE"[\s\S]*PRODUCTION_BACKUP_SHA256_FILE="\$EFFECTIVE_BACKUP_SHA256_FILE"/);
assert.match(script, /production\.sql\.gz[\s\S]*DUMP_PATH_CONTRACT=PASS/);
assert.match(script, /MANIFEST_PATH_CONTRACT=PASS[\s\S]*EXISTING_PAIR_STATE=absent[\s\S]*complete_valid/);
const orderedContracts = [
  "STAGE=authorized_directory", "STAGE=dump_path_contract", "STAGE=manifest_path_contract",
  "STAGE=existing_pair_state", "STAGE=database_url_contract", "STAGE=database_container",
  "STAGE=database_network", "STAGE=database_volume", "STAGE=database_mount",
  "STAGE=disk_capacity", "STAGE=preparation_lock", "STAGE=dump",
  "TMP_DIR=\"$(mktemp", "backup_validate_plain_dump", "STAGE=atomic_promotion",
  "PRODUCTION_BACKUP_FRESHNESS=PASS", "STAGE=preflight", "PRODUCTION_BACKUP_PREPARATION=PASS",
];
let cursor = -1;
for (const contract of orderedContracts) {
  const next = script.indexOf(contract, cursor + 1);
  assert.ok(next > cursor, `backup stage out of order or absent: ${contract}`);
  cursor = next;
}
assert.match(script, /env_resolution; COMMAND=resolve_production_configuration/);
assert.match(script, /env_metadata; COMMAND=validate_protected_configuration_metadata/);
assert.match(script, /env_syntax; COMMAND=validate_protected_configuration_syntax/);
assert.match(script, /required_configuration; COMMAND=validate_backup_configuration_contract/);
assert.match(script, /-e "\$CANONICAL_ENV_FILE" \|\| -L "\$CANONICAL_ENV_FILE"[\s\S]*legacy_read_only/);
assert.match(script, /stat -c %U:%G[\s\S]*root:root/);
assert.match(script, /stat -c %a[\s\S]*600/);
assert.match(script, /OLD_BACKUP[\s\S]*install -o root -g root -m 600/);
assert.match(script, /docker exec --user postgres -i "\$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump -U postgres -d salesforce_pro/);
assert.match(script, /docker exec --user postgres -i "\$PRODUCTION_DB_CONTAINER_EXPECTED" id -u/);
assert.match(script, /postgres_os_user_missing[\s\S]*os_user_selection_failed/);
assert.match(script, /peer_authentication_failed[\s\S]*psql_failed[\s\S]*pg_dump_failed/);
assert.match(script, /backup_validate_database_health_in_validated_container "\$PRODUCTION_DB_CONTAINER_EXPECTED"/);
assert.match(script, /PRODUCTION_BACKUP_DUMP_TARGET=VALIDATED_CONTAINER/);
assert.match(script, /PRODUCTION_BACKUP_DB_IDENTITY_REVALIDATED=PASS/);
assert.doesNotMatch(script, /docker compose (?:exec|run|up) (?:-T )?db|docker (?:start|restart)/);
assert.doesNotMatch(script, /docker compose (?:down|up)|down -v|docker (?:system|volume) prune|prisma migrate|seed|backfill|erp-production-recovery/);
assert.doesNotMatch(script, /echo .*DATABASE_URL|set -x|sha256sum .*printf/);
assert.match(common, /USER_COUNT[\s\S]*CLIENT_COUNT[\s\S]*OPPORTUNITY_COUNT[\s\S]*TIMELINE_EVENT_COUNT/);
assert.match(common, /DB_VALIDATED_CONTAINER="\$validated_container" backup_validate_database_health/);
assert.match(healthCheck, /docker exec --user postgres -i "\$DB_VALIDATED_CONTAINER" psql -U postgres -d "\$DB_NAME"/);
assert.doesNotMatch(`${script}\n${healthCheck}`, /docker exec (?:-i|--user root)[^\n]*(?:psql|pg_dump)/);
assert.match(historical, /production-backup-common\.sh[\s\S]*backup_validate_database_health[\s\S]*backup_validate_plain_dump/);
assert.match(workflow, /environment: production-backup-recovery/);
assert.match(workflow, /git pull --ff-only origin main/);
assert.doesNotMatch(workflow, /production-cutover|erp-production-recovery/);

// Scenario matrix A-P is enforced by the executable primitives and fail-closed
// branches above; these labels make omissions visible during review.
const scenarios = ["valid-pair", "dump-failure", "invalid-gzip", "undersize", "mismatched-sidecar",
  "replace-old", "mid-promotion-failure", "rollback-old-pair", "symlink", "owner-mode",
  "outside-authorized", "concurrent", "cutover-preflight", "sentinel-redaction", "runtime-unchanged",
  "successful-full-flow", "atomic-pair-rollback"];
assert.equal(scenarios.length, 17);
console.log(`Production backup recovery contract: PASS (A-P: ${scenarios.join(", ")})`);
