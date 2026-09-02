#!/usr/bin/env node
import { readFileSync } from "node:fs";
const migration=readFileSync("apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql","utf8");
const runner=readFileSync("scripts/tenancy-expand-roots-runner.sh","utf8");
const workflow=readFileSync(".github/workflows/production-tenancy-expand-roots.yml","utf8");
const envWrapper=readFileSync("scripts/run-production-tenancy-expand-roots.sh","utf8");
const preflightProof=readFileSync("scripts/lib/production-preflight-proof.sh","utf8");
const forbidden=/\b(UPDATE|DELETE|DROP|TRUNCATE|INSERT)\b|NOT\s+NULL|CREATE\s+TABLE\s+"Tenant"/i;
if(forbidden.test(migration)) throw new Error("expand migration contains data/destructive operation");
for(const token of ["EXPECTED_SHA","origin/main","RUNTIME_TENANCY_MODE","DATABASE_SCHEMA_MODE","ABSENT_COMPATIBLE","ALREADY_APPLIED","ON_ERROR_STOP","BEGIN;","PR827","_prisma_migrations","pr827_backup_proof_validate","production_preflight_proof_validate","APPLY_TENANCY_EXPAND_ROOTS","result.tsv.tmp"])
  if(!runner.includes(token)) throw new Error(`runner contract missing ${token}`);
if(!workflow.includes("environment: production-schema") || !workflow.includes("APPLY_TENANCY_EXPAND_ROOTS")) throw new Error("workflow apply gate missing");
if(!workflow.includes("run-production-tenancy-expand-roots.sh") || workflow.includes('DATABASE_URL="$DATABASE_URL"')) throw new Error("workflow canonical env call graph missing");
for(const token of ["RUN_PRODUCTION_PREFLIGHT=true","PREFLIGHT_RESULT_FILE=/var/log/gest-o/preflight/latest/result.tsv"]) if(!workflow.includes(token)) throw new Error(`workflow preflight contract missing ${token}`);
if(!envWrapper.includes("resolve-production-env.sh") || !envWrapper.includes("MODE=cutover") || !envWrapper.includes("PRODUCTION_PREFLIGHT_MODE=cutover bash scripts/production-preflight.sh") || !envWrapper.includes("exec bash scripts/tenancy-expand-roots-runner.sh")) throw new Error("canonical env/preflight wrapper contract missing");
if(envWrapper.indexOf("production-preflight.sh") > envWrapper.indexOf("tenancy-expand-roots-runner.sh")) throw new Error("preflight must precede apply runner");
for(const text of [runner,workflow,envWrapper,preflightProof]) if(/\|\|\s*true|continue-on-error\s*:\s*true/.test(text)) throw new Error("preflight bypass present");
if(runner.includes('stat -c %a "PREFLIGHT_RESULT_FILE"')) throw new Error("literal preflight result filename regression");
if(/(?:echo|printf)[^\n]*PASS[^\n]*PREFLIGHT_RESULT_FILE/.test(workflow+envWrapper)) throw new Error("manual PASS publication regression");
if(/grep[^\n]*PREFLIGHT_RESULT_FILE/.test(runner)) throw new Error("grep-only preflight validation regression");
for(const token of ["FORMAT","STATUS","SHA","MODE","DATABASE","DB_CONTAINER","DB_VOLUME","CREATED_AT_EPOCH","BUNDLE_ID","mktemp -d","os.fsync","mv \"$stage\" \"$latest\""]) if(!preflightProof.includes(token)) throw new Error(`shared proof contract missing ${token}`);
console.log("TENANCY_EXPAND_ROOTS_STATIC_SAFETY=PASS");
