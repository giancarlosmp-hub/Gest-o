#!/usr/bin/env node
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2] ?? 0, "utf8").trim().split("\n").filter(Boolean);
const expected = new Map([
  ["enum\tErpOrderManualResolutionCategory", "manual_verified_not_found"],
  ["enum\tErpOrderManualResolutionTerminalState", "manually_resolved_not_found"],
  ["table\tErpOrderManualResolution", "r"],
  ["column\tErpOrderSync.supersedesErpOrderSyncId", "YES:text"],
]);
for (const name of ["ErpOrderManualResolution_erpOrderSyncId_key", "ErpOrderManualResolution_opportunityId_createdAt_idx", "ErpOrderManualResolution_resolvedById_createdAt_idx", "ErpOrderSync_supersedesErpOrderSyncId_idx"])
  expected.set(`index\t${name}`, /CREATE (?:UNIQUE )?INDEX/);
for (const name of ["ErpOrderSync_supersedesErpOrderSyncId_fkey", "ErpOrderManualResolution_erpOrderSyncId_fkey", "ErpOrderManualResolution_opportunityId_fkey", "ErpOrderManualResolution_resolvedById_fkey"])
  expected.set(`fk\t${name}`, /FOREIGN KEY .* ON UPDATE CASCADE ON DELETE RESTRICT/);
if (rows.length !== expected.size) throw new Error("CATALOG_NOT_EXACT");
for (const row of rows) {
  const [kind, name, ...detailParts] = row.split("\t");
  const wanted = expected.get(`${kind}\t${name}`); const detail = detailParts.join("\t");
  if (wanted === undefined || (wanted instanceof RegExp ? !wanted.test(detail) : detail !== wanted)) throw new Error(`CATALOG_DIVERGENT:${kind}:${name}`);
}
console.log("PR827_MIGRATION_CATALOG=PASS");
