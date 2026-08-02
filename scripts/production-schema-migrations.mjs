#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const validationVersion = "schema-operation-v2";
export const migrations = Object.freeze({
  "20260731150000_safe_production_schema_transition": Object.freeze({
    migrationId: "20260731150000_safe_production_schema_transition",
    path: "apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql",
    sha256: "66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506",
    expectedObjects: Object.freeze({ tables: 5, enums: 7, contactColumns: 2 }),
    requires: null, type: "schema", idempotency: "repeatable-additive",
    postconditions: "managed-prisma-diff-empty-at-original-schema-sha", evidenceVersion: 1
  }),
  "20260802120000_tenancy_control_plane": Object.freeze({
    migrationId: "20260802120000_tenancy_control_plane",
    path: "apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql",
    sha256: "b9298218b3c34cdadaf35f31a6d0e8a6e1942e9d1cbf5ae5c77ae305d1cc554d",
    expectedObjects: Object.freeze({ tables: ["Tenant", "TenantMembership"], enums: ["TenantStatus", "TenantMembershipStatus", "TenantRole"], indexes: ["Tenant_slug_key", "TenantMembership_tenantId_userId_key", "TenantMembership_userId_status_idx", "TenantMembership_tenantId_status_idx"], foreignKeys: ["TenantMembership_tenantId_fkey", "TenantMembership_userId_fkey"], checks: ["TenantMembership_version_positive", "TenantMembership_lifecycle_coherent"] }),
    requires: "20260731150000_safe_production_schema_transition", type: "schema",
    idempotency: "single-apply; compatible reexecution is evidence-only",
    postconditions: "full-managed-schema-diff-empty-and-control-plane-empty-before-preparation", evidenceVersion: 2
  })
});

export function migration(id) {
  const entry = migrations[id];
  if (!entry) throw new Error(`UNKNOWN_MIGRATION_ID:${id}`);
  const actual = createHash("sha256").update(readFileSync(resolve(root, entry.path))).digest("hex");
  if (actual !== entry.sha256) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${id}`);
  return entry;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const entry = migration(process.argv[2]);
  process.stdout.write(`${entry.migrationId}\t${entry.path}\t${entry.sha256}\t${entry.requires ?? "-"}\t${entry.evidenceVersion}\n`);
}
