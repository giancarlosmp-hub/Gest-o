import assert from "node:assert/strict";
import { validateAuthenticatedRecovery } from "../lib/erp-authenticated-validation.mjs";

const response = (status, body) => ({ status, json: async () => body });
const automatic = { initialized: true, enabled: true, enabledByEnv: true, configurationOk: true, authMode: "global", nextRunAt: "2026-08-26T13:00:00Z" };
const fetchSequence = (...items) => async () => {
  const item = items.shift();
  if (item instanceof Error) throw item;
  return item;
};
const run = (items, attempts = 1) => validateAuthenticatedRecovery({
  baseUrl: "http://127.0.0.1:4000", email: "secret-email", password: "secret-password",
  attempts, delayMs: 0, fetchImpl: fetchSequence(...items),
});

let result = await run([response(200, { accessToken: "secret-token" }), response(200, {}), response(200, { automaticSync: automatic })]);
assert.equal(result.ok, true); assert.equal(result.lastPass, "next_run_at");

result = await run([response(401, {})]);
assert.deepEqual({ category: result.category, lastPass: result.lastPass, httpClass: result.httpClass }, { category: "login_http", lastPass: "api_health", httpClass: "4xx" });
result = await run([response(200, {})]); assert.equal(result.category, "token_contract");
result = await run([response(200, { accessToken: "secret-token" }), response(403, {})]); assert.equal(result.category, "authenticated_identity_http");
result = await run([response(200, { accessToken: "secret-token" }), response(200, {}), response(404, {})]); assert.equal(result.category, "protected_endpoint_http");
result = await run([response(200, { accessToken: "secret-token" }), response(200, {}), response(200, {})]); assert.equal(result.category, "protected_endpoint_schema");

const login = () => [response(200, { accessToken: "secret-token" }), response(200, {})];
result = await run([...login(), response(200, { automaticSync: { ...automatic, initialized: false, nextRunAt: null } })]);
assert.equal(result.category, "scheduler_not_initialized");
result = await run([...login(), response(200, { automaticSync: { ...automatic, enabledByEnv: false } })]); assert.equal(result.category, "scheduler_disabled");
result = await run([...login(), response(200, { automaticSync: { ...automatic, nextRunAt: null } })]); assert.equal(result.category, "next_run_at_absent");

result = await run([
  ...login(), response(200, { automaticSync: { ...automatic, initialized: false, nextRunAt: null } }),
  ...login(), response(200, { automaticSync: automatic }),
], 2);
assert.equal(result.ok, true, "legitimate bootstrap delay must converge inside the bound");
result = await run([new Error("temporary"), new Error("still unavailable")], 2);
assert.equal(result.category, "transport_timeout");

const serialized = JSON.stringify(result);
assert.doesNotMatch(serialized, /secret-email|secret-password|secret-token/);
console.log("ERP authenticated validation call graph: PASS");
