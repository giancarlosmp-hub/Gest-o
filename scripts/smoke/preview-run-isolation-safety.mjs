import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const read=(path)=>readFileSync(new URL(`../../${path}`,import.meta.url),"utf8");
const base=read("docker-compose.yml"), override=read("docker-compose.preview.yml"), workflow=read(".github/workflows/preview.yml"), cleanup=read(".github/workflows/preview-cleanup.yml");
assert.doesNotMatch(base+override,/container_name\s*:/);
for (const token of ["github.run_id", "github.run_attempt", "com.gesto.preview.pr", "com.gesto.preview.run-id", "com.gesto.preview.run-attempt", "com.gesto.preview.workflow", "API_PORT: 0", "WEB_PORT: 0", "validate_current_run_ownership"])
  assert.match(workflow+override,new RegExp(token.replace(/[.?]/g,"\\$&")));
for (const token of ["actions/runs/${owner_run}", "run_status", "completed", "com.gesto.preview.pr", "com.gesto.preview.workflow", "gesto-pr-${PR_NUMBER}-"])
  assert.ok(cleanup.includes(token),`missing cleanup ownership gate: ${token}`);
assert.doesNotMatch(cleanup+workflow,/docker (?:system|network|volume) prune|docker prune/);
function config(run,attempt){
  const project=`gesto-pr-836-${run}-${attempt}`;
  const result=spawnSync("docker",["compose","-p",project,"-f","docker-compose.yml","-f","docker-compose.preview.yml","config"],{encoding:"utf8",env:{...process.env,COMPOSE_PROJECT_NAME:project,POSTGRES_DB:`preview_836_${run}_${attempt}`,POSTGRES_VOLUME_NAME:`gesto_pgdata_pr_836_${run}_${attempt}`,API_PORT:"0",WEB_PORT:"0",PREVIEW_OWNER_PR:"836",PREVIEW_OWNER_RUN_ID:String(run),PREVIEW_OWNER_RUN_ATTEMPT:String(attempt),PREVIEW_OWNER_WORKFLOW:"Preview-Deploy"}});
  if (result.error?.code === "ENOENT") { console.error("SKIP: docker compose unavailable locally"); process.exit(77); }
  assert.equal(result.status,0,result.stderr); return {project,text:result.stdout};
}
const first=config(1001,1), second=config(1002,1);
assert.notEqual(first.project,second.project);
assert.match(first.text,/gesto-pr-836-1001-1/); assert.match(second.text,/gesto-pr-836-1002-1/);
assert.match(first.text,/gesto_pgdata_pr_836_1001_1/); assert.match(second.text,/gesto_pgdata_pr_836_1002_1/);
assert.doesNotMatch(first.text,/gesto-pr-836-1002-1/); assert.doesNotMatch(second.text,/gesto-pr-836-1001-1/);
console.log("PREVIEW_CONCURRENT_RUN_ISOLATION=PASS");
