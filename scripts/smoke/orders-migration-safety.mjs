import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const harness = readFileSync("scripts/smoke/orders-migration-postgres.sh", "utf8");
const migration = readFileSync("apps/api/prisma/migrations/20260904120000_orders_operational_view/migration.sql", "utf8");
assert.match(harness, /fresh_sequence predecessor_baseline[\s\S]*previous\/schema\.prisma/, "fresh supported install must materialize the supported predecessor baseline");
assert.doesNotMatch(harness, /prisma migrate deploy/, "incomplete historical migration chain must not be presented as a fresh-install contract");
assert.match(harness, /20260904120000_orders_operational_view\/migration\.sql/);
for (const proof of ["fresh.diff", "upgrade.diff", "migration-backfill", "order-orphan", "unresolved_count", "ErpOrderSync_tenantId_fkey", "ErpOrderStatusHistory_erpOrderSyncId_fkey"]) assert.ok(harness.includes(proof), proof);
for (const marker of ["ORDERS_MIGRATION_PHASE=", "ORDERS_MIGRATION_NAME=", "ORDERS_MIGRATION_ERROR_CODE=", "ORDERS_MIGRATION_RESULT="]) assert.ok(harness.includes(marker), marker);
assert.match(harness, /apply_orders_migration fresh fresh_sequence/, "fresh proof must reach the orders migration");
assert.match(harness, /chmod 600/, "diagnostic logs must be private");
assert.doesNotMatch(harness, />\/dev\/null 2>&1[^\n]*20260904120000/, "migration errors must remain observable");
assert.match(migration, /^BEGIN;/);
assert.match(migration, /COMMIT;\s*$/);
assert.doesNotMatch(migration, /^\s*(?:DELETE|TRUNCATE|DROP\s+TABLE)\b/im);
console.log("orders migration harness safety passed");
