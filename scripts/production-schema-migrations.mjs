#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const migrations = Object.freeze({
  "20260802120000_tenancy_control_plane": Object.freeze({
    id: "20260802120000_tenancy_control_plane",
    path: "apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql",
    sha256: "b9298218b3c34cdadaf35f31a6d0e8a6e1942e9d1cbf5ae5c77ae305d1cc554d",
    introCommit: "581fbae0a545f53800db7707ab8b28f52dcd3fa1",
    predecessor: Object.freeze({
      commit: "dc7ceb0f0a23b77fc45a58960f3371b50c7f7365",
      schemaPath: "apps/api/prisma/schema.prisma",
      schemaSha256: "0576893d97a0d7b55ca73316cfe6af6774eeccc1e91807fe4fa45c8fdad7f24c",
      lastMigration: "20260731150000_safe_production_schema_transition"
    }),
    objects: Object.freeze({
      enums: ["TenantStatus", "TenantMembershipStatus", "TenantRole"],
      tables: ["Tenant", "TenantMembership"],
      indexes: ["Tenant_slug_key", "TenantMembership_userId_status_idx", "TenantMembership_tenantId_status_idx", "TenantMembership_tenantId_userId_key"],
      foreignKeys: ["TenantMembership_tenantId_fkey", "TenantMembership_userId_fkey"],
      checks: ["TenantMembership_version_positive", "TenantMembership_lifecycle_coherent"]
    }),
    postconditions: Object.freeze(["catalog-exact", "control-plane-empty", "managed-diff-empty", "incident-objects-preserved"]),
    evidenceVersion: 1
  }),
  "20260827190000_add_erp_order_manual_resolution": Object.freeze({
    id: "20260827190000_add_erp_order_manual_resolution",
    path: "apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql",
    sha256: "61b4443a685471ea0425613d97da35a06cedf677d77c26807ce7ff27ccdb5b9e",
    predecessor: Object.freeze({
      lastMigration: "20260808120000_tenancy_expand_roots",
      sha256: "90b25a912cd48ae03eb662355ebff271e9a84e63bc11b75f9ec0b41d2669d996"
    }),
    objects: Object.freeze({
      enums: ["ErpOrderManualResolutionCategory", "ErpOrderManualResolutionTerminalState"],
      tables: ["ErpOrderManualResolution"],
      columns: ["ErpOrderSync.supersedesErpOrderSyncId"],
      indexes: ["ErpOrderManualResolution_erpOrderSyncId_key", "ErpOrderManualResolution_opportunityId_createdAt_idx", "ErpOrderManualResolution_resolvedById_createdAt_idx", "ErpOrderSync_supersedesErpOrderSyncId_idx"],
      foreignKeys: ["ErpOrderSync_supersedesErpOrderSyncId_fkey", "ErpOrderManualResolution_erpOrderSyncId_fkey", "ErpOrderManualResolution_opportunityId_fkey", "ErpOrderManualResolution_resolvedById_fkey"]
    }),
    postconditions: Object.freeze(["ledger-finalized", "catalog-exact", "managed-diff-empty", "old-api-compatible"]),
    evidenceVersion: 1
  })
});

export function resolveMigration(id) {
  const migration = migrations[id];
  if (!migration) throw new Error("UNKNOWN_MIGRATION_ID");
  const absolutePath = resolve(root, migration.path);
  const actual = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  if (actual !== migration.sha256) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
  return { ...migration, absolutePath, actualSha256: actual };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  try { process.stdout.write(`${JSON.stringify(resolveMigration(id))}\n`); }
  catch (error) { console.error(error.message); process.exit(2); }
}
