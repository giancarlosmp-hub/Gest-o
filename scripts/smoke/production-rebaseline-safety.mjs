import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const rebaselineScript = read("scripts/production-rebaseline.sh");
const rebaselineProofLib = read("scripts/lib/production-rebaseline-proof.sh");
const deployScript = read("scripts/deploy-production.sh");

// Static Assertions & Safety Checks
assert.match(rebaselineScript, /PRODUCTION_REBASELINE_APPROVED/);
assert.match(rebaselineScript, /EXPECTED_SHA/);
assert.match(rebaselineScript, /docker save/);
assert.doesNotMatch(rebaselineScript, /docker commit|docker export/);
assert.doesNotMatch(rebaselineScript, /docker rm|docker rmi|docker stop/);
assert.match(rebaselineScript, /unavailable_legacy_artifact/);
assert.match(rebaselineScript, /cutover_executed\\tNO/);

assert.match(deployScript, /validate_rebaseline_evidence/);
assert.match(deployScript, /method=authorized-rebaseline/);

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
