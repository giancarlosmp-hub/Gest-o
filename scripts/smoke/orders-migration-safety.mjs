import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const harness = readFileSync("scripts/smoke/orders-migration-postgres.sh", "utf8");
const migration = readFileSync("apps/api/prisma/migrations/20260904120000_orders_operational_view/migration.sql", "utf8");
assert.match(harness, /prisma db push[^\n]*schema\.prisma/, "fresh supported install must use the repository ephemeral-push baseline");
assert.doesNotMatch(harness, /prisma migrate deploy/, "incomplete historical migration chain must not be presented as a fresh-install contract");
assert.match(harness, /20260904120000_orders_operational_view\/migration\.sql/);
for (const proof of ["fresh.diff", "upgrade.diff", "migration-backfill", "order-orphan", "unresolved_count", "ErpOrderSync_tenantId_fkey", "ErpOrderStatusHistory_erpOrderSyncId_fkey"]) assert.ok(harness.includes(proof), proof);
assert.match(migration, /^BEGIN;/);
assert.match(migration, /COMMIT;\s*$/);
assert.doesNotMatch(migration, /^\s*(?:DELETE|TRUNCATE|DROP\s+TABLE)\b/im);
console.log("orders migration harness safety passed");
