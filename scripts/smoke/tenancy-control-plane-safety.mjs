#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const read = path => readFileSync(resolve(root, path), "utf8");
const schema = read("apps/api/prisma/schema.prisma");
const migration = read("apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql");
const runner = read("apps/api/src/scripts/prepareDefaultTenant.ts");
const preparation = read("apps/api/src/tenancy/defaultTenantPreparation.ts");
const mode = read("apps/api/src/tenancy/tenancyMode.ts");
const bootstrap = read("apps/api/src/scripts/bootstrap.ts") + read("apps/api/src/server.ts");
const seeds = read("apps/api/prisma/seed.js") + read("apps/api/src/scripts/seedDefaultUsers.ts");
const compose = read("docker-compose.production.yml");

assert.match(schema, /model Tenant \{/);
assert.match(schema, /model TenantMembership \{/);
assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b|ON DELETE CASCADE/i);
for (const table of ["Client", "Contact", "Opportunity", "Activity", "AgendaEvent", "Product", "KnowledgeDocument"]) {
  const body = schema.match(new RegExp(`model ${table} \\{([\\s\\S]*?)\\n\\}`))?.[1] || "";
  assert.doesNotMatch(body, /^\s*tenantId\s/m, `${table} acquired tenantId`);
}
assert.doesNotMatch(bootstrap, /prepareDefaultTenant/);
assert.doesNotMatch(seeds, /tenant-default-v1|TenantMembership|tenant\.create/);
assert.match(compose, /TENANCY_MODE:\s*disabled/);
assert.match(mode, /"disabled" \| "default-only"/);
assert.doesNotMatch(mode, /multi-tenant/);
assert.doesNotMatch(runner, /body|query|header|production\.env/i);
assert.doesNotMatch(preparation, /select:\s*\{[^}]*\b(?:email|name|passwordHash)\b/s);
assert.match(preparation, /isolationLevel: "Serializable"/);
assert.match(runner, /CONFIRM/);
assert.match(runner, /EXPECTED_SHA/);
for (const path of ["scripts/deploy-production.sh", "docker-compose.production.yml"]) assert.doesNotMatch(read(path), /prisma\s+db\s+push/);

const registry = read("scripts/production-schema-migrations.mjs");
const wrapper = read("scripts/production-tenant-default-prepare.sh");
assert.match(registry, /20260731150000_safe_production_schema_transition/);
assert.match(registry, /20260802120000_tenancy_control_plane/);
assert.match(registry, /MIGRATION_CHECKSUM_MISMATCH/);
assert.match(registry, /UNKNOWN_MIGRATION_ID/);
assert.match(wrapper, /OPERATIONAL_GATE_SHA256/);
assert.match(wrapper, /org\.opencontainers\.image\.revision/);
assert.match(wrapper, /schema-state\.tsv/);
assert.match(wrapper, /dry-run\.PASS\.tsv/);
assert.match(wrapper, /CONFIRM=PREPARE_DEFAULT_TENANT/);
assert.doesNotMatch(wrapper, /docker compose (?:up|down)|production\.env|prisma db push/);
assert.doesNotMatch(compose, /TENANCY_MODE:\s*default-only/);
console.log("tenancy control-plane static safety passed");
