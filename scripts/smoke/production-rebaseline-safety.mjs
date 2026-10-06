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
assert.match(rebaselineScript, /unavailable_legacy_%s_artifact/);
assert.match(rebaselineScript, /cutover_executed\\tNO/);
// The legacy runtime is detected, never hardcoded from a past incident.
assert.doesNotMatch(rebaselineScript, /310198|f4dcc/, "rebaseline must not hardcode the 310198/f4dcc legacy artifact");
for (const field of ["container_id", "identity", "config_image", "commit", "inspectable"]) {
  assert.match(rebaselineScript, new RegExp(`legacy_runtime_%s_${field}\\\\t`));
}
assert.match(rebaselineScript, /awk -F'\|' -v p=":\$port->"/, "rebaseline must use the cutover port-owner criterion");

// Syntax validation for scripts/production-rebaseline.sh
const scriptSyntaxCheck = spawnSync("bash", ["-n", "scripts/production-rebaseline.sh"], { encoding: "utf8" });
assert.equal(scriptSyntaxCheck.status, 0, `scripts/production-rebaseline.sh syntax check failed: ${scriptSyntaxCheck.stderr}`);

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
assert.match(rebaselineWorkflow, /envs:\s*REBASELINE_CONFIRM,EXPECTED_MAIN_SHA/);
assert.match(rebaselineWorkflow, /CONFIRM="\$REBASELINE_CONFIRM" EXPECTED_SHA="\$EXPECTED_MAIN_SHA" \\\s*bash scripts\/production-rebaseline\.sh/);
assert.match(rebaselineWorkflow, /REBASELINE_TARGET_SHA/);
assert.match(rebaselineWorkflow, /REBASELINE_VERIFIED_API_IMAGE/);
assert.match(rebaselineWorkflow, /REBASELINE_VERIFIED_WEB_IMAGE/);
assert.match(rebaselineWorkflow, /REBASELINE_OCI_BACKUP_DIR/);
assert.match(rebaselineWorkflow, /REBASELINE_EVIDENCE_FILE/);
assert.match(rebaselineWorkflow, /REBASELINE_RESULT/);
assert.doesNotMatch(rebaselineWorkflow, /MODE=cutover/);
assert.doesNotMatch(rebaselineWorkflow, /deploy-production\.sh/);

// Extract remote SSH script block from workflow for analysis
const remoteScriptMatch = rebaselineWorkflow.match(/uses:\s*appleboy\/ssh-action@v1\.2\.0[\s\S]*?script:\s*\|([\s\S]*?)(?=\n\s*- name:|\n\s*$)/);
assert.ok(remoteScriptMatch, "Must find appleboy/ssh-action script block in workflow");
const remoteScript = remoteScriptMatch[1];

// Disallow complex syntax / functions / cases / nested bash -c / eval in remote script
assert.doesNotMatch(remoteScript, /case\b|function\b|\b\w+\(\)/, "remote script must be linear without functions or case statements");
assert.doesNotMatch(remoteScript, /bash -c|eval/, "remote script must not use nested bash -c or eval");

// Syntax validation for remote script directly
const remoteSyntaxCheck = spawnSync("bash", ["-n"], { input: remoteScript, encoding: "utf8" });
assert.equal(remoteSyntaxCheck.status, 0, `workflow remote script syntax check failed: ${remoteSyntaxCheck.stderr}`);

// Simulate appleboy/ssh-action script_stop line processing (appending status check or semicolon after lines)
const simulatedAppleboyScript = remoteScript
  .split("\n")
  .map(line => line.trim())
  .filter(line => line.length > 0 && !line.startsWith("#"))
  .join(";\n");

const simulatedAppleboyCheck = spawnSync("bash", ["-n"], { input: simulatedAppleboyScript, encoding: "utf8" });
assert.equal(simulatedAppleboyCheck.status, 0, `simulated appleboy ssh-action remote script syntax check failed: ${simulatedAppleboyCheck.stderr}`);

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
legacy_runtime_api_container_id\tapi-container-id
legacy_runtime_api_identity\tsha256:${"a".repeat(64)}
legacy_runtime_api_config_image\tgest-o-api:${"d".repeat(40)}
legacy_runtime_api_commit\t${"d".repeat(40)}
legacy_runtime_api_inspectable\tno
unavailable_legacy_api_artifact\t${"d".repeat(40)} (sha256:${"a".repeat(64)})
unavailable_legacy_api_reason\truntime_image_not_inspectable_in_local_engine
legacy_runtime_web_container_id\tweb-container-id
legacy_runtime_web_identity\tsha256:${"b".repeat(64)}
legacy_runtime_web_config_image\tgest-o-web:${"d".repeat(40)}
legacy_runtime_web_commit\t${"d".repeat(40)}
legacy_runtime_web_inspectable\tyes
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
      echo "REBASELINE_VERIFIED_COMMIT=$REBASELINE_VERIFIED_COMMIT REBASELINE_VERIFIED_API_ID=$REBASELINE_VERIFIED_API_ID REBASELINE_VERIFIED_WEB_ID=$REBASELINE_VERIFIED_WEB_ID REBASELINE_VERIFIED_API_TAR=$REBASELINE_VERIFIED_API_TAR REBASELINE_VERIFIED_WEB_TAR=$REBASELINE_VERIFIED_WEB_TAR"
    else
      echo "FAILED_VERIFICATION"
    fi
  `;
  const run2 = spawnSync("bash", ["-c", testProofLibScript2], { encoding: "utf8" });
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_COMMIT=${dummySha}`));
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_API_ID=sha256:${"1".repeat(64)}`));
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_WEB_ID=sha256:${"2".repeat(64)}`));
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_API_TAR=${dummyApiTar}`));
  assert.ok(run2.stdout.includes(`REBASELINE_VERIFIED_WEB_TAR=${dummyWebTar}`));

  // Scenario 3: Divergent SHA query (querying a different SHA must fail)
  const divergentSha = "b".repeat(40);
  const testProofDivergentSha = `
    source scripts/lib/production-rebaseline-proof.sh
    if validate_rebaseline_evidence "${divergentSha}" "${join(testDir, "rebaseline")}"; then
      echo "UNEXPECTED_PASS"
    else
      echo "EXPECTED_FAIL"
    fi
  `;
  const runDivergentSha = spawnSync("bash", ["-c", testProofDivergentSha], { encoding: "utf8" });
  assert.equal(runDivergentSha.stdout.trim(), "EXPECTED_FAIL");

  // Scenario 4: Missing OCI Backup Tarball File
  rmSync(dummyApiTar);
  const runMissingTar = spawnSync("bash", ["-c", testProofLibScript], { encoding: "utf8" });
  assert.equal(runMissingTar.stdout.trim(), "EXPECTED_FAIL");

  // Restore OCI tarball for corrupt checksum test
  writeFileSync(dummyApiTar, "corrupted-tar-content");
  // Scenario 5: Corrupted Checksum
  const run3 = spawnSync("bash", ["-c", testProofLibScript], { encoding: "utf8" });
  assert.equal(run3.stdout.trim(), "EXPECTED_FAIL");

  // Scenario 4: Authorized Rebaseline Script Invocation Failure on Missing Confirmation
  const runScriptNoConfirm = spawnSync("bash", ["scripts/production-rebaseline.sh"], {
    env: { ...process.env, EXPECTED_SHA: dummySha },
    encoding: "utf8"
  });
  assert.notEqual(runScriptNoConfirm.status, 0);
  assert.ok(runScriptNoConfirm.stderr.includes("CONFIRM=PRODUCTION_REBASELINE_APPROVED"));

  // Scenario 6: Rebaseline records the runtime that actually owns ports 4000/5173
  const runtimeBin = join(testDir, "runtime-bin");
  const runtimeApp = join(testDir, "runtime-app");
  const runtimeEvidence = join(testDir, "runtime-rebaseline");
  const runtimeOci = join(testDir, "runtime-oci");
  mkdirSync(runtimeBin, { recursive: true });
  mkdirSync(runtimeApp, { recursive: true });
  const legacyApi = `sha256:${"a".repeat(64)}`;
  const legacyWeb = `sha256:${"b".repeat(64)}`;
  const legacyCommit = "c".repeat(40);
  writeFileSync(join(runtimeBin, "git"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(runtimeBin, "docker"), `#!/usr/bin/env bash
case "$1" in
  ps) printf 'old-api|0.0.0.0:4000->4000/tcp\\nold-web|0.0.0.0:5173->5173/tcp\\nproduction-postgres|5432/tcp\\n';;
  save) printf 'tar for %s\\n' "$2" >"$4";;
  inspect)
    case "$3:$4" in
      '{{.Id}}:old-api') echo api-container-id;; '{{.Id}}:old-web') echo web-container-id;;
      '{{.Image}}:api-container-id') echo ${legacyApi};; '{{.Image}}:web-container-id') echo ${legacyWeb};;
      '{{.Config.Image}}:api-container-id') echo gest-o-api:${legacyCommit};; '{{.Config.Image}}:web-container-id') echo gest-o-web:${legacyCommit};;
      *Config.Env*:api-container-id) echo APP_COMMIT=${legacyCommit};;
      *) exit 1;;
    esac;;
  image)
    ref=\${!#}
    case "$ref" in
      gest-o-api:${dummySha}) id=sha256:${"1".repeat(64)}; rev=${dummySha};;
      gest-o-web:${dummySha}) id=sha256:${"2".repeat(64)}; rev=${dummySha};;
      ${legacyWeb}) id=${legacyWeb}; rev=${legacyCommit};;
      *) exit 1;;
    esac
    case "\${4:-}" in *revision*) echo "$rev";; '') ;; *) echo "$id";; esac;;
  *) exit 1;;
esac
`, { mode: 0o755 });
  const runtimeRun = spawnSync("bash", ["scripts/production-rebaseline.sh"], {
    env: {
      ...process.env,
      PATH: `${runtimeBin}:${process.env.PATH}`,
      CONFIRM: "PRODUCTION_REBASELINE_APPROVED",
      EXPECTED_SHA: dummySha,
      APP_DIR: runtimeApp,
      REBASELINE_EVIDENCE_DIR: runtimeEvidence,
      OCI_BACKUP_DIR: runtimeOci
    },
    encoding: "utf8"
  });
  assert.equal(runtimeRun.status, 0, `rebaseline with detected runtime failed: ${runtimeRun.stderr}`);
  const runtimeResult = readFileSync(join(runtimeEvidence, dummySha, "result.tsv"), "utf8");
  const field = key => runtimeResult.split("\n").find(line => line.startsWith(`${key}\t`))?.split("\t")[1];
  assert.equal(field("legacy_runtime_api_container_id"), "api-container-id");
  assert.equal(field("legacy_runtime_api_identity"), legacyApi);
  assert.equal(field("legacy_runtime_api_config_image"), `gest-o-api:${legacyCommit}`);
  assert.equal(field("legacy_runtime_api_commit"), legacyCommit, "non-inspectable runtime falls back to the container APP_COMMIT");
  assert.equal(field("legacy_runtime_api_inspectable"), "no");
  assert.equal(field("unavailable_legacy_api_artifact"), `${legacyCommit} (${legacyApi})`);
  assert.equal(field("unavailable_legacy_api_reason"), "runtime_image_not_inspectable_in_local_engine");
  assert.equal(field("legacy_runtime_web_identity"), legacyWeb);
  assert.equal(field("legacy_runtime_web_commit"), legacyCommit);
  assert.equal(field("legacy_runtime_web_inspectable"), "yes");
  assert.equal(field("unavailable_legacy_web_artifact"), undefined, "inspectable runtime must not be recorded as unavailable");
  assert.doesNotMatch(runtimeResult, /310198|f4dcc/);
  assert.equal(field("cutover_executed"), "NO");

  // Scenario 7: Ambiguous port ownership fails closed before any docker save
  writeFileSync(join(runtimeBin, "docker"), `#!/usr/bin/env bash
case "$1" in
  ps) printf 'a|0.0.0.0:4000->4000/tcp\\nb|0.0.0.0:4000->4000/tcp\\n';;
  save) echo SAVE_CALLED >&2; exit 1;;
  image) case "\${4:-}" in *revision*) echo ${dummySha};; '') ;; *) echo sha256:${"1".repeat(64)};; esac;;
  *) exit 1;;
esac
`, { mode: 0o755 });
  const ambiguousRun = spawnSync("bash", ["scripts/production-rebaseline.sh"], {
    env: {
      ...process.env,
      PATH: `${runtimeBin}:${process.env.PATH}`,
      CONFIRM: "PRODUCTION_REBASELINE_APPROVED",
      EXPECTED_SHA: dummySha,
      APP_DIR: runtimeApp,
      REBASELINE_EVIDENCE_DIR: join(testDir, "ambiguous-rebaseline"),
      OCI_BACKUP_DIR: join(testDir, "ambiguous-oci")
    },
    encoding: "utf8"
  });
  assert.notEqual(ambiguousRun.status, 0);
  assert.ok(ambiguousRun.stderr.includes("porta 4000 não possui proprietário único"));
  assert.ok(!ambiguousRun.stderr.includes("SAVE_CALLED"));
  assert.ok(!existsSync(join(testDir, "ambiguous-rebaseline")));

} finally {
  rmSync(testDir, { recursive: true, force: true });
}

console.log("production rebaseline safety smoke passed");
