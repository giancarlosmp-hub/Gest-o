import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const read=(path)=>readFileSync(new URL(`../../${path}`,import.meta.url),"utf8");
const base=read("docker-compose.yml"), override=read("docker-compose.preview.yml"), workflow=read(".github/workflows/preview.yml"), cleanupWorkflow=read(".github/workflows/preview-cleanup.yml"), cleanupRunner=read("scripts/preview-cleanup-remote.sh"), lifecycle=read("scripts/preview-image-lifecycle.mjs");
assert.doesNotMatch(base+override,/container_name\s*:/);
for (const token of ["github.run_id", "github.run_attempt", "com.gesto.preview.pr", "com.gesto.preview.run-id", "com.gesto.preview.run-attempt", "com.gesto.preview.workflow", "API_PORT: 0", "WEB_PORT: 0", "validate_current_run_ownership"])
  assert.match(workflow+override,new RegExp(token.replace(/[.?]/g,"\\$&")));
// The workflow is transport/orchestration; ownership lives in the exact
// versioned scripts that it copies and invokes. Keep this linkage explicit so
// moving the shell cannot silently remove the test's coverage again.
for (const token of [
  "source: scripts/preview-image-lifecycle.mjs,scripts/preview-cleanup-remote.sh",
  "CLEANUP_SCRIPT: /tmp/gesto-preview-cleanup-${{ github.run_id }}/scripts/preview-image-lifecycle.mjs",
  "CLEANUP_RUNNER: /tmp/gesto-preview-cleanup-${{ github.run_id }}/scripts/preview-cleanup-remote.sh",
  'bash "$CLEANUP_RUNNER"',
]) assert.ok(cleanupWorkflow.includes(token),`cleanup workflow no longer transports/invokes trusted script: ${token}`);
for (const token of ["actions/runs/${owner_run}/attempts/${owner_attempt}", "run_status", "completed", "com.gesto.preview.pr", "com.gesto.preview.run-id", "com.gesto.preview.run-attempt", "com.gesto.preview.workflow", "gesto-pr-${PR_NUMBER}-"])
  assert.ok(cleanupRunner.includes(token),`missing remote cleanup ownership gate: ${token}`);
for (const token of [
  "if (!process.env.GITHUB_TOKEN) die('github_auth_missing')",
  "`/pulls/${expectedBase.pr}`", "pr.state !== 'closed'",
  "`/actions/runs/${expectedBase['run-id']}/attempts/${expectedBase['run-attempt']}`", "run.status !== 'completed'", "run.conclusion !== 'success'",
  "run.run_attempt", "run.head_sha", "run.name !== 'Preview Deploy'", "run.event !== 'pull_request'",
  "run.pull_requests", "run_pr_correlation_missing", "concurrent_run_${status}",
]) assert.ok(lifecycle.includes(token),`authenticated cleanup correlation weakened: ${token}`);
assert.doesNotMatch(cleanupWorkflow+cleanupRunner+workflow,/docker (?:system|network|volume) prune|docker prune/);
console.log("PREVIEW_CLEANUP_TRUSTED_SCRIPT_CONTRACT=PASS authenticated_owner_run=PASS");
function config(run,attempt){
  const project=`gesto-pr-836-${run}-${attempt}`;
  const result=spawnSync("docker",["compose","-p",project,"-f","docker-compose.yml","-f","docker-compose.preview.yml","config"],{encoding:"utf8",env:{...process.env,COMPOSE_PROJECT_NAME:project,POSTGRES_DB:`preview_836_${run}_${attempt}`,POSTGRES_VOLUME_NAME:`gesto_pgdata_pr_836_${run}_${attempt}`,API_PORT:"0",WEB_PORT:"0",PREVIEW_OWNER_PR:"836",PREVIEW_OWNER_RUN_ID:String(run),PREVIEW_OWNER_RUN_ATTEMPT:String(attempt),PREVIEW_OWNER_WORKFLOW:"Preview-Deploy"}});
  if (result.error?.code === "ENOENT") { console.error("SKIP: docker compose unavailable locally"); process.exit(77); }
  assert.equal(result.status,0,result.stderr);
  for (const service of ["db", "api", "web"]) {
    const block=result.stdout.match(new RegExp(`^  ${service}:\\n(.*?)(?=^  [a-zA-Z0-9_-]+:|^networks:|^volumes:|(?![\\s\\S]))`,"ms"))?.[1]||"";
    assert.match(block,/logging:\s*\n\s*driver: json-file\s*\n\s*options:\s*\n\s*max-file: "4"\s*\n\s*max-size: 25m/,`${service} effective log rotation`);
  }
  return {project,text:result.stdout};
}
const first=config(1001,1), second=config(1002,1);
assert.notEqual(first.project,second.project);
assert.match(first.text,/gesto-pr-836-1001-1/); assert.match(second.text,/gesto-pr-836-1002-1/);
assert.match(first.text,/gesto_pgdata_pr_836_1001_1/); assert.match(second.text,/gesto_pgdata_pr_836_1002_1/);
assert.doesNotMatch(first.text,/gesto-pr-836-1002-1/); assert.doesNotMatch(second.text,/gesto-pr-836-1001-1/);
console.log("PREVIEW_CONCURRENT_RUN_ISOLATION=PASS log_rotation=PASS");
