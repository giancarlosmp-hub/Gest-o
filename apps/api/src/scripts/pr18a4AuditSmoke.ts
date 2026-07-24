import assert from "node:assert/strict";
import { repairErpClientDryRun } from "../services/erpClientAuditService.js";

const result = await repairErpClientDryRun({ erpCode: "5050" });
assert.equal(result.mode, "DRY_RUN_ONLY");
assert.equal(result.wouldMutate, false);
assert.ok(Array.isArray(result.before.records));
assert.ok(result.before.clientsApiAudit.searchFields.includes("code"));
console.log("pr18a4 audit smoke ok");
