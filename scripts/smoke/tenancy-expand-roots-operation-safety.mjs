#!/usr/bin/env node
import { readFileSync } from "node:fs";
const migration=readFileSync("apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql","utf8");
const runner=readFileSync("scripts/tenancy-expand-roots-runner.sh","utf8");
const workflow=readFileSync(".github/workflows/production-tenancy-expand-roots.yml","utf8");
const forbidden=/\b(UPDATE|DELETE|DROP|TRUNCATE|INSERT)\b|NOT\s+NULL|CREATE\s+TABLE\s+"Tenant"/i;
if(forbidden.test(migration)) throw new Error("expand migration contains data/destructive operation");
for(const token of ["EXPECTED_SHA","origin/main","RUNTIME_TENANCY_MODE","DATABASE_SCHEMA_MODE","ABSENT_COMPATIBLE","ALREADY_APPLIED","ON_ERROR_STOP","BEGIN;","PR827","_prisma_migrations","pr827_backup_proof_validate","APPLY_TENANCY_EXPAND_ROOTS","result.tsv.tmp"])
  if(!runner.includes(token)) throw new Error(`runner contract missing ${token}`);
if(!workflow.includes("environment: production-schema") || !workflow.includes("APPLY_TENANCY_EXPAND_ROOTS")) throw new Error("workflow apply gate missing");
console.log("TENANCY_EXPAND_ROOTS_STATIC_SAFETY=PASS");
