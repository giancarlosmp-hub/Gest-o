import assert from "node:assert/strict";
import { buildClientCodeAuditData } from "./clientCodeAuditService.js";

const base = { clientId: "client-1", origin: "API" as const, requestId: "req-1" };
assert.equal(buildClientCodeAuditData({ ...base, oldValue: " 5050 ", newValue: "5050" }), null);
assert.deepEqual(buildClientCodeAuditData({ ...base, oldValue: "4484", newValue: "5050", partnerErp: "5050" }), {
  clientId: "client-1", partnerErp: "5050", oldValue: "4484", newValue: "5050", origin: "API",
  actorUserId: null, actorEmail: null, requestIp: null, requestId: "req-1", metadata: undefined,
});
console.log("client code audit tests ok");
