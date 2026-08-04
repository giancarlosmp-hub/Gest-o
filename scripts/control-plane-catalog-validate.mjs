#!/usr/bin/env node
import { readFileSync } from "node:fs";

const input = process.argv[2];
if (!input) throw new Error("usage: control-plane-catalog-validate.mjs INVENTORY.tsv");
const rows = readFileSync(input, "utf8").trim().split("\n").filter(Boolean).map(line => {
  const [kind, object, position, ...detail] = line.split("\t");
  return { kind, object, position: Number(position), detail: detail.join("\t") };
});
const expectedNames = {
  enum: ["TenantMembershipStatus", "TenantRole", "TenantStatus"],
  table: ["Tenant", "TenantMembership"],
  pk: ["TenantMembership_pkey", "Tenant_pkey"],
  fk: ["TenantMembership_tenantId_fkey", "TenantMembership_userId_fkey"],
  check: ["TenantMembership_lifecycle_coherent", "TenantMembership_version_positive"],
  index: ["TenantMembership_pkey", "TenantMembership_tenantId_status_idx", "TenantMembership_tenantId_userId_key", "TenantMembership_userId_status_idx", "Tenant_pkey", "Tenant_slug_key"]
};
const names = kind => [...new Set(rows.filter(row => row.kind === kind).map(row => row.object))].sort();
for (const [kind, expected] of Object.entries(expectedNames)) {
  if (JSON.stringify(names(kind)) !== JSON.stringify(expected)) throw new Error(`CATALOG_${kind.toUpperCase()}_MISMATCH`);
}
const enumExpected = {
  TenantStatus: ["active", "suspended", "archived"],
  TenantMembershipStatus: ["invited", "active", "revoked"],
  TenantRole: ["diretor", "gerente", "vendedor"]
};
for (const [name, expected] of Object.entries(enumExpected)) {
  const actual = rows.filter(row => row.kind === "enum" && row.object === name).sort((a,b) => a.position-b.position).map(row => row.detail);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`CATALOG_ENUM_VALUES_MISMATCH:${name}`);
}
const columns = new Map(rows.filter(row => row.kind === "column").map(row => [row.object, row.detail]));
const expectedColumns = {
  "Tenant.id":"text|text|NO|", "Tenant.slug":"text|text|NO|", "Tenant.legalName":"text|text|NO|", "Tenant.displayName":"text|text|NO|",
  "Tenant.status":"USER-DEFINED|TenantStatus|NO|'active'::\"TenantStatus\"", "Tenant.createdAt":"timestamp without time zone|timestamp|NO|CURRENT_TIMESTAMP",
  "Tenant.updatedAt":"timestamp without time zone|timestamp|NO|", "Tenant.suspendedAt":"timestamp without time zone|timestamp|YES|",
  "TenantMembership.id":"text|text|NO|", "TenantMembership.tenantId":"text|text|NO|", "TenantMembership.userId":"text|text|NO|",
  "TenantMembership.role":"USER-DEFINED|TenantRole|NO|", "TenantMembership.status":"USER-DEFINED|TenantMembershipStatus|NO|", "TenantMembership.version":"integer|int4|NO|",
  "TenantMembership.invitedAt":"timestamp without time zone|timestamp|YES|", "TenantMembership.acceptedAt":"timestamp without time zone|timestamp|YES|",
  "TenantMembership.revokedAt":"timestamp without time zone|timestamp|YES|", "TenantMembership.createdAt":"timestamp without time zone|timestamp|NO|CURRENT_TIMESTAMP",
  "TenantMembership.updatedAt":"timestamp without time zone|timestamp|NO|"
};
if (columns.size !== Object.keys(expectedColumns).length) throw new Error("CATALOG_COLUMN_COUNT_MISMATCH");
for (const [name, expected] of Object.entries(expectedColumns)) if (columns.get(name) !== expected) throw new Error(`CATALOG_COLUMN_MISMATCH:${name}`);
const detail = name => rows.find(row => row.object === name)?.detail || "";
for (const [name, fragments] of Object.entries({
  TenantMembership_tenantId_fkey:["FOREIGN KEY (\"tenantId\")", "REFERENCES \"Tenant\"(id)", "ON UPDATE CASCADE", "ON DELETE RESTRICT"],
  TenantMembership_userId_fkey:["FOREIGN KEY (\"userId\")", "REFERENCES \"User\"(id)", "ON UPDATE CASCADE", "ON DELETE RESTRICT"],
  TenantMembership_version_positive:["CHECK", "version > 0"],
  TenantMembership_lifecycle_coherent:["invited", "active", "revoked", "acceptedAt", "revokedAt"]
})) for (const fragment of fragments) if (!detail(name).includes(fragment)) throw new Error(`CATALOG_DEFINITION_MISMATCH:${name}`);
const indexExpected = {
  Tenant_slug_key:'CREATE UNIQUE INDEX "Tenant_slug_key" ON public."Tenant" USING btree (slug)',
  TenantMembership_tenantId_userId_key:'CREATE UNIQUE INDEX "TenantMembership_tenantId_userId_key" ON public."TenantMembership" USING btree ("tenantId", "userId")',
  TenantMembership_userId_status_idx:'CREATE INDEX "TenantMembership_userId_status_idx" ON public."TenantMembership" USING btree ("userId", status)',
  TenantMembership_tenantId_status_idx:'CREATE INDEX "TenantMembership_tenantId_status_idx" ON public."TenantMembership" USING btree ("tenantId", status)'
};
for (const [name, expected] of Object.entries(indexExpected)) if (detail(name) !== expected) throw new Error(`CATALOG_INDEX_MISMATCH:${name}`);
console.log("CONTROL_PLANE_CATALOG_PASS");
