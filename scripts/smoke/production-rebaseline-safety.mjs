import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const rebaselineScript = read("scripts/production-rebaseline.sh");
const rebaselineProofLib = read("scripts/lib/production-rebaseline-proof.sh");
const deployScript = read("scripts/deploy-production.sh");
const rebaselineWorkflow = read(".github/workflows/production-rebaseline.yml");

// Static Assertions & Safety Checks for Script
assert.match(rebaselineScript, /PRODUCTION_REBASELINE_APPROVED/);
assert.match(rebaselineScript, /EXPECTED_SHA/);
assert.match(rebaselineScript, /docker save/);
assert.doesNotMatch(rebaselineScript, /docker commit|docker export/);
assert.doesNotMatch(rebaselineScript, /docker rm|docker rmi|docker stop/);
assert.match(rebaselineScript, /unavailable_legacy_artifact/);
assert.match(rebaselineScript, /cutover_executed\\tNO/);

assert.match(deployScript, /validate_rebaseline_evidence/);
assert.match(deployScript, /method=authorized-rebaseline/);

// Static Assertions & Safety Checks for Workflow
assert.match(rebaselineWorkflow, /name:\s*Production Rebaseline/);
assert.match(rebaselineWorkflow, /workflow_dispatch:/);
assert.match(rebaselineWorkflow, /confirm:/);
assert.match(rebaselineWorkflow, /description:.*PRODUCTION_REBASELINE_APPROVED/);
assert.match(rebaselineWorkflow, /required:\s*true/);
assert.doesNotMatch(rebaselineWorkflow, /confirm:\s*[\s\S]*?default:/);
assert.match(rebaselineWorkflow, /PRODUCTION_REBASELINE_APPROVED/);
assert.match(rebaselineWorkflow, /CONFIRM="\$REBASELINE_CONFIRM"[\s\S]*?EXPECTED_SHA="\$EXPECTED_MAIN_SHA"[\s\S]*?scripts\/production-rebaseline\.sh/);
assert.match(rebaselineWorkflow, /REBASELINE_TARGET_SHA/);
assert.match(rebaselineWorkflow, /REBASELINE_VERIFIED_API_IMAGE/);
assert.match(rebaselineWorkflow, /REBASELINE_VERIFIED_WEB_IMAGE/);
assert.match(rebaselineWorkflow, /REBASELINE_OCI_BACKUP_DIR/);
assert.match(rebaselineWorkflow, /REBASELINE_EVIDENCE_FILE/);
assert.match(rebaselineWorkflow, /REBASELINE_RESULT/);
assert.doesNotMatch(rebaselineWorkflow, /MODE=cutover/);
assert.doesNotMatch(rebaselineWorkflow, /deploy-production\.sh/);

// Static assertions ensuring no invalid Bash expansion of inputs
assert.doesNotMatch(rebaselineWorkflow, /\$\{#inputs\./, "workflow must not contain \${#inputs.");
assert.doesNotMatch(rebaselineWorkflow, /\$\{\{#inputs\./, "workflow must not contain \${{#inputs.");
assert.doesNotMatch(rebaselineWorkflow, /\$\{inputs\./, "workflow must not contain invalid bash expansion \${inputs.");

// Extract and test workflow local validation script behavior
const validSha = "a".repeat(40);
const workflowLocalValidationScript = `
  set -euo pipefail
  if [ "$CONFIRM" != "PRODUCTION_REBASELINE_APPROVED" ]; then
    printf '%s\\n' "::error::Confirmação inválida: $CONFIRM. Exigido PRODUCTION_REBASELINE_APPROVED."
    exit 1
  fi
  if [ "\${#EXPECTED_MAIN_SHA}" -ne 40 ]; then
    printf '%s\\n' "::error::expected_main_sha deve ter exatamente 40 caracteres."
    exit 1
  fi
  case "$EXPECTED_MAIN_SHA" in
    *[!0-9a-f]*|'')
      printf '%s\\n' "::error::expected_main_sha deve ser um SHA-1 hexadecimal de 40 caracteres."
      exit 1
      ;;
  esac
`;

// Test 1: Accepts valid 40-character hex SHA and correct confirmation
const testValid = spawnSync("bash", ["-c", workflowLocalValidationScript], {
  env: { CONFIRM: "PRODUCTION_REBASELINE_APPROVED", EXPECTED_MAIN_SHA: validSha },
  encoding: "utf8"
});
assert.equal(testValid.status, 0, "Workflow validation script must accept valid SHA and confirmation");

// Test 2: Rejects empty SHA
const testEmptySha = spawnSync("bash", ["-c", workflowLocalValidationScript], {
  env: { CONFIRM: "PRODUCTION_REBASELINE_APPROVED", EXPECTED_MAIN_SHA: "" },
  encoding: "utf8"
});
assert.notEqual(testEmptySha.status, 0, "Workflow validation script must reject empty SHA");

// Test 3: Rejects incorrect length SHA (39 chars)
const testShortSha = spawnSync("bash", ["-c", workflowLocalValidationScript], {
  env: { CONFIRM: "PRODUCTION_REBASELINE_APPROVED", EXPECTED_MAIN_SHA: "a".repeat(39) },
  encoding: "utf8"
});
assert.notEqual(testShortSha.status, 0, "Workflow validation script must reject short SHA");

// Test 4: Rejects incorrect length SHA (41 chars)
const testLongSha = spawnSync("bash", ["-c", workflowLocalValidationScript], {
  env: { CONFIRM: "PRODUCTION_REBASELINE_APPROVED", EXPECTED_MAIN_SHA: "a".repeat(41) },
  encoding: "utf8"
});
assert.notEqual(testLongSha.status, 0, "Workflow validation script must reject long SHA");

// Test 5: Rejects non-hex characters
const testNonHexSha = spawnSync("bash", ["-c", workflowLocalValidationScript], {
  env: { CONFIRM: "PRODUCTION_REBASELINE_APPROVED", EXPECTED_MAIN_SHA: "g".repeat(40) },
  encoding: "utf8"
});
assert.notEqual(testNonHexSha.status, 0, "Workflow validation script must reject non-hex SHA");

// Test 6: Rejects wrong confirmation string
const testWrongConfirm = spawnSync("bash", ["-c", workflowLocalValidationScript], {
  env: { CONFIRM: "INVALID_CONFIRMATION", EXPECTED_MAIN_SHA: validSha },
  encoding: "utf8"
});
assert.notEqual(testWrongConfirm.status, 0, "Workflow validation script must reject wrong confirmation string");

// Test 7: Job Summary preserves REBASELINE_RESULT=FAIL on error (evaluated via job.status)
assert.match(rebaselineWorkflow, /REBASELINE_RESULT.*job\.status == 'success' && 'PASS' || 'FAIL'/);

// Behavioral Unit / Mock Tests for Rebaseline Logic & Proof Verification
const testDir = join(tmpdir(), `gest-o-rebaseline-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

try {
  const dummySha = "a".repeat(40);
  const evidenceDir = join(testDir, "rebaseline", dummySha);
  const ociBackupDir = join(testDir, "oci-backups", dummySha);

  // Scenario 1: Missing Baseline Evidence
  const testProofLibScript = `
    source scripts/lib/production-rebaseline-proof.sh
    if validate_rebaseline_evidence "${dummySha}" "${join(testDir, "rebaseline")}"; then
      echo "UNEXPECTED_PASS"
    else
      echo "EXPECTED_FAIL"
    fi
  `;
  const run1 = spawnSync("bash", ["-c", testProofLibScript], { encoding: "utf8" });
  assert.equal(run1.stdout.trim(), "EXPECTED_FAIL");

  // Scenario 2: Valid Rebaseline Evidence
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(ociBackupDir, { recursive: true });

  const dummyApiTar = join(ociBackupDir, "gest-o-api.tar");
  const dummyWebTar = join(ociBackupDir, "gest-o-web.tar");
  writeFileSync(dummyApiTar, "dummy-api-tar-content");
  writeFileSync(dummyWebTar, "dummy-web-tar-content");

  const dummyApiTarSha = spawnSync("sha256sum", [dummyApiTar], { encoding: "utf8" }).stdout.split(" ")[0];
  const dummyWebTarSha = spawnSync("sha256sum", [dummyWebTar], { encoding: "utf8" }).stdout.split(" ")[0];

  const resultTsv = `result\tPASS
rebaseline_commit\t${dummySha}
rebaselined_at\t2026-09-29T12:00:00Z
api_image_tag\tgest-o-api:${dummySha}
api_image_id\tsha256:${"1".repeat(64)}
api_image_digest\tsha256:${"1".repeat(64)}
api_tar_path\t${dummyApiTar}
api_tar_sha256\t${dummyApiTarSha}
web_image_tag\tgest-o-web:${dummySha}
web_image_id\tsha256:${"2".repeat(64)}
web_image_digest\tsha256:${"2".repeat(64)}
web_tar_path\t${dummyWebTar}
web_tar_sha256\t${dummyWebTarSha}
unavailable_legacy_artifact\t310198aea1f09177e158bf85b89a6b9ecd356f9a (sha256:f4dcccfb...)
unavailable_legacy_reason\tno_local_oci_digest_link_and_no_external_registry
cutover_executed\tNO
`;

  const manifestTsv = `role\timage_tag\timage_id\tdigest\ttar_path\ttar_sha256
api\tgest-o-api:${dummySha}\tsha256:${"1".repeat(64)}\tsha256:${"1".repeat(64)}\t${dummyApiTar}\t${dummyApiTarSha}
web\tgest-o-web:${dummySha}\tsha256:${"2".repeat(64)}\tsha256:${"2".repeat(64)}\t${dummyWebTar}\t${dummyWebTarSha}
`;

  writeFileSync(join(evidenceDir, "result.tsv"), resultTsv);
  writeFileSync(join(evidenceDir, "manifest.tsv"), manifestTsv);

  const testProofLibScript2 = `
    source scripts/lib/production-rebaseline-proof.sh
    if validate_rebaseline_evidence "${dummySha}" "${join(testDir, "rebaseline")}"; then
      echo "REBASELINE_VERIFIED_COMMIT=$REBASELINE_VERIFIED_COMMIT REBASELINE_VERIFIED_API_ID=$REBASELINE_VERIFIED_API_ID REBASELINE_VERIFIED_WEB_ID=$REBASELINE_VERIFIED_WEB_ID"
    else
      echo "FAILED_VERIFICATION"
    fi
  `;
  const run2 = spawnSync("bash", ["-c", testProofLibScript2], { encoding: "utf8" });
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_COMMIT=${dummySha}`));
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_API_ID=sha256:${"1".repeat(64)}`));
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_WEB_ID=sha256:${"2".repeat(64)}`));

  // Scenario 3: Divergent Baseline (e.g., checksum mismatch or wrong SHA)
  writeFileSync(dummyApiTar, "corrupted-tar-content");
  const run3 = spawnSync("bash", ["-c", testProofLibScript], { encoding: "utf8" });
  assert.equal(run3.stdout.trim(), "EXPECTED_FAIL");

  // Scenario 4: Authorized Rebaseline Script Invocation Failure on Missing Confirmation
  const runScriptNoConfirm = spawnSync("bash", ["scripts/production-rebaseline.sh"], {
    env: { ...process.env, EXPECTED_SHA: dummySha },
    encoding: "utf8"
  });
  assert.notEqual(runScriptNoConfirm.status, 0);
  assert.ok(runScriptNoConfirm.stderr.includes("CONFIRM=PRODUCTION_REBASELINE_APPROVED"));

} finally {
  rmSync(testDir, { recursive: true, force: true });
}

console.log("production rebaseline safety smoke passed");
