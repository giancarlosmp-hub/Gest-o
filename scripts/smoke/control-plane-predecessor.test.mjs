#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveControlPlanePredecessor } from "../resolve-control-plane-predecessor.mjs";

const cpTokens = ["model Tenant {}", "model TenantMembership {}", "enum TenantStatus { active }", "enum TenantMembershipStatus { active }", "enum TenantRole { diretor }"];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = (root, path, contents) => { mkdirSync(dirname(join(root,path)), { recursive:true }); writeFileSync(join(root,path), contents); };
function fixture({ predecessorSchema="model User {}\n", secondSchema=false, migrationInIntro=true }={}) {
  const cwd=mkdtempSync(join(tmpdir(),"gesto-predecessor-")); git(cwd,"init","-q"); git(cwd,"config","user.email","test@example.invalid"); git(cwd,"config","user.name","Test");
  put(cwd,"apps/api/prisma/schema.prisma",predecessorSchema); put(cwd,"apps/api/prisma/migrations/prev/migration.sql","SELECT 1;\n");
  if(secondSchema) put(cwd,"other/schema.prisma","model Other {}\n");
  git(cwd,"add","."); git(cwd,"commit","-qm","predecessor"); const predecessorCommit=git(cwd,"rev-parse","HEAD");
  put(cwd,"apps/api/prisma/schema.prisma",`${predecessorSchema}\n${cpTokens.join("\n")}\n`);
  if(migrationInIntro) put(cwd,"apps/api/prisma/migrations/control/migration.sql","SELECT 2;\n");
  git(cwd,"add","."); git(cwd,"commit","-qm","intro"); const introCommit=git(cwd,"rev-parse","HEAD");
  const schemaSha256=createHash("sha256").update(predecessorSchema).digest("hex");
  const migration={ introCommit, path:"apps/api/prisma/migrations/control/migration.sql", predecessor:{commit:predecessorCommit,schemaPath:"apps/api/prisma/schema.prisma",schemaSha256,lastMigration:"prev"} };
  return {cwd,migration};
}
const fails=(config, pattern, mutate=x=>x.migration) => { const f=fixture(config); try { assert.throws(()=>resolveControlPlanePredecessor({cwd:f.cwd,migration:mutate(f)}),pattern); } finally { rmSync(f.cwd,{recursive:true,force:true}); } };

fails({},/COMMIT_NOT_FOUND/,f=>({...f.migration,predecessor:{...f.migration.predecessor,commit:"0".repeat(40)}}));
fails({},/PREDECESSOR_SCHEMA_PATH_MISMATCH/,f=>({...f.migration,predecessor:{...f.migration.predecessor,schemaPath:"working-tree-only/schema.prisma"}}));
{ const f=fixture(); put(f.cwd,"working-tree-only/schema.prisma","model User {}\n"); assert.throws(()=>resolveControlPlanePredecessor({cwd:f.cwd,migration:{...f.migration,predecessor:{...f.migration.predecessor,schemaPath:"working-tree-only/schema.prisma"}}}),/PATH_MISMATCH/); rmSync(f.cwd,{recursive:true,force:true}); }
fails({secondSchema:true},/PREDECESSOR_SCHEMA_AMBIGUOUS:2/);
fails({predecessorSchema:"model User {}\nmodel Tenant {}\n"},/CONTROL_PLANE_TOKEN_IN_PREDECESSOR:model Tenant/);
fails({predecessorSchema:"model User {}\nmodel TenantMembership {}\n"},/CONTROL_PLANE_TOKEN_IN_PREDECESSOR:model TenantMembership/);
for(const token of cpTokens.slice(2)) fails({predecessorSchema:`model User {}\n${token}\n`},/CONTROL_PLANE_TOKEN_IN_PREDECESSOR/);
fails({},/CHECKSUM_MISMATCH/,f=>({...f.migration,predecessor:{...f.migration.predecessor,schemaSha256:"0".repeat(64)}}));
fails({},/INTRO_PARENT_MISMATCH/,f=>({...f.migration,introCommit:f.migration.predecessor.commit,predecessor:{...f.migration.predecessor,commit:f.migration.introCommit}}));
fails({migrationInIntro:false},/CONTROL_PLANE_MIGRATION_MISSING_FROM_INTRO/);
const harness=readFileSync(resolve("scripts/smoke/tenancy-control-plane-operation-postgres.sh"),"utf8");
assert.match(harness,/resolve-control-plane-predecessor\.mjs --write-schema/);
assert.doesNotMatch(harness,/git show .*schema\.prisma|cp .*apps\/api\/prisma\/schema\.prisma|cat apps\/api\/prisma\/schema\.prisma/);
assert.match(harness,/--write-intro-schema/);
assert.match(harness,/--to-schema-datamodel \/tmp\/control-plane\.prisma/);
assert.doesNotMatch(harness,/--to-schema-datamodel apps\/api\/prisma\/schema\.prisma/);
assert.match(harness,/HARNESS_STEP=%s.*HARNESS_RESULT=FAIL.*EXIT_CODE=%s/s);
// Regression for PR #783: later root expands must not enter the historical control-plane diff.
{ const registered = resolveControlPlanePredecessor(); const current = readFileSync(resolve("apps/api/prisma/schema.prisma"), "utf8"); assert.match(current, /TenantClients/); assert.doesNotMatch(registered.introSchema, /TenantClients|TenantErpSyncRuns/); }
const resolver=readFileSync(resolve("scripts/resolve-control-plane-predecessor.mjs"),"utf8");
assert.match(resolver,/cat-file.*predecessor\.commit.*predecessor\.schemaPath/s);
console.log("control-plane predecessor resolver regressions passed");
