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
    predecessor: "20260731150000_safe_production_schema_transition",
    objects: Object.freeze({
      enums: ["TenantStatus", "TenantMembershipStatus", "TenantRole"],
      tables: ["Tenant", "TenantMembership"],
      indexes: ["Tenant_slug_key", "TenantMembership_userId_status_idx", "TenantMembership_tenantId_status_idx", "TenantMembership_tenantId_userId_key"],
      foreignKeys: ["TenantMembership_tenantId_fkey", "TenantMembership_userId_fkey"],
      checks: ["TenantMembership_version_positive", "TenantMembership_lifecycle_coherent"]
    }),
    postconditions: Object.freeze(["catalog-exact", "control-plane-empty", "managed-diff-empty", "incident-objects-preserved"]),
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
