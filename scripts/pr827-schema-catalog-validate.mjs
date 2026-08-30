#!/usr/bin/env node
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2] ?? 0, "utf8").trim().split("\n").filter(Boolean);
const expected = new Map([
  ["enum\tErpOrderManualResolutionCategory", "manual_verified_not_found"],
  ["enum\tErpOrderManualResolutionTerminalState", "manually_resolved_not_found"],
  ["table\tErpOrderManualResolution", "r"],
  ["column\tErpOrderSync.supersedesErpOrderSyncId", "YES:text:text:"],
  ["column\tErpOrderManualResolution.id", "NO:text:text:"],
  ["column\tErpOrderManualResolution.erpOrderSyncId", "NO:text:text:"],
  ["column\tErpOrderManualResolution.opportunityId", "NO:text:text:"],
  ["column\tErpOrderManualResolution.resolvedById", "NO:text:text:"],
  ["column\tErpOrderManualResolution.resolvedRole", "NO:USER-DEFINED:Role:"],
  ["column\tErpOrderManualResolution.category", "NO:USER-DEFINED:ErpOrderManualResolutionCategory:"],
  ["column\tErpOrderManualResolution.terminalState", "NO:USER-DEFINED:ErpOrderManualResolutionTerminalState:"],
  ["column\tErpOrderManualResolution.justification", "NO:text:text:"],
  ["column\tErpOrderManualResolution.originalPedidoIdImportacao", "NO:text:text:"],
  ["column\tErpOrderManualResolution.originalCorrelationId", "NO:text:text:"],
  ["column\tErpOrderManualResolution.statusCheckedAt", "NO:timestamp without time zone:timestamp:"],
  ["column\tErpOrderManualResolution.statusCheckCorrelationId", "NO:text:text:"],
  ["column\tErpOrderManualResolution.createdAt", "NO:timestamp without time zone:timestamp:CURRENT_TIMESTAMP"],
  ["pk\tErpOrderManualResolution_pkey", "PRIMARY KEY (id)"],
]);
expected.set("index\tErpOrderManualResolution_erpOrderSyncId_key", /^CREATE UNIQUE INDEX .* ON public\."ErpOrderManualResolution" USING btree \("erpOrderSyncId"\)$/);
expected.set("index\tErpOrderManualResolution_opportunityId_createdAt_idx", /^CREATE INDEX .* ON public\."ErpOrderManualResolution" USING btree \("opportunityId", "createdAt"\)$/);
expected.set("index\tErpOrderManualResolution_resolvedById_createdAt_idx", /^CREATE INDEX .* ON public\."ErpOrderManualResolution" USING btree \("resolvedById", "createdAt"\)$/);
expected.set("index\tErpOrderSync_supersedesErpOrderSyncId_idx", /^CREATE INDEX .* ON public\."ErpOrderSync" USING btree \("supersedesErpOrderSyncId"\)$/);
expected.set("fk\tErpOrderSync_supersedesErpOrderSyncId_fkey", /^FOREIGN KEY \("supersedesErpOrderSyncId"\) REFERENCES "ErpOrderSync"\(id\) ON UPDATE CASCADE ON DELETE RESTRICT$/);
expected.set("fk\tErpOrderManualResolution_erpOrderSyncId_fkey", /^FOREIGN KEY \("erpOrderSyncId"\) REFERENCES "ErpOrderSync"\(id\) ON UPDATE CASCADE ON DELETE RESTRICT$/);
expected.set("fk\tErpOrderManualResolution_opportunityId_fkey", /^FOREIGN KEY \("opportunityId"\) REFERENCES "Opportunity"\(id\) ON UPDATE CASCADE ON DELETE RESTRICT$/);
expected.set("fk\tErpOrderManualResolution_resolvedById_fkey", /^FOREIGN KEY \("resolvedById"\) REFERENCES "User"\(id\) ON UPDATE CASCADE ON DELETE RESTRICT$/);
if (rows.length !== expected.size) throw new Error("CATALOG_NOT_EXACT");
for (const row of rows) {
  const [kind, name, ...detailParts] = row.split("\t");
  const wanted = expected.get(`${kind}\t${name}`); const detail = detailParts.join("\t");
  if (wanted === undefined || (wanted instanceof RegExp ? !wanted.test(detail) : detail !== wanted)) throw new Error(`CATALOG_DIVERGENT:${kind}:${name}`);
}
console.log("PR827_MIGRATION_CATALOG=PASS");
