import assert from "node:assert/strict";
import { validateAuthenticatedRecovery } from "../lib/erp-authenticated-validation.mjs";

const response = (status, body, headers = {}) => ({
  status, json: async () => body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});
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
const identity = (role = "diretor") => response(200, { id: "user-id", role });

let result = await run([response(200, { accessToken: "secret-token" }), identity(), response(200, { automaticSync: automatic }, { "x-gestao-response-origin": "api" })]);
assert.equal(result.ok, true); assert.equal(result.lastPass, "next_run_at");
assert.equal(result.httpOrigin, "api");
result = await run([response(200, { accessToken: "secret-token" }), identity(), response(429, {}, { server: "nginx" })]);
assert.equal(result.httpOrigin, "reverse_proxy");

result = await run([response(401, {})]);
assert.deepEqual({ category: result.category, lastPass: result.lastPass, httpClass: result.httpClass }, { category: "login_http", lastPass: "api_health", httpClass: "4xx" });
result = await run([response(200, {})]); assert.equal(result.category, "token_contract");
result = await run([response(200, { accessToken: "secret-token" }), response(403, {})]); assert.equal(result.category, "authenticated_identity_http");
result = await run([response(200, { accessToken: "secret-token" }), identity(), response(404, {})]); assert.equal(result.category, "protected_endpoint_http"); assert.equal(result.httpStatus, "404");
for (const status of [400, 401, 403, 405, 409, 422, 429]) {
  result = await run([response(200, { accessToken: "secret-token" }), identity(), response(status, {})]);
  assert.equal(result.httpStatus, String(status));
}
for (let status = 400; status < 500; status += 1) {
  result = await run([response(200, { accessToken: "secret-token" }), identity(), response(status, {})]);
  assert.equal(result.httpStatus, String(status));
}
result = await run([response(200, { accessToken: "secret-token" }), identity(), response(200, {})]); assert.equal(result.category, "protected_endpoint_schema");

const login = () => [response(200, { accessToken: "secret-token" }), identity("gerente")];
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

const calls = [];
result = await validateAuthenticatedRecovery({
  baseUrl: "http://127.0.0.1:4000", email: "secret-email", password: "secret-password", attempts: 1,
  fetchImpl: async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", authorization: init.headers?.authorization });
    if (url.endsWith("/auth/login")) return response(200, { accessToken: "secret-token" });
    if (url.endsWith("/auth/me")) return identity();
    return response(200, { automaticSync: automatic });
  },
});
assert.equal(result.ok, true);
assert.deepEqual(calls.map(({ url, method }) => [new URL(url).pathname, method]), [
  ["/auth/login", "POST"], ["/auth/me", "GET"], ["/erp/ultrafv3/scheduler/status", "GET"],
]);
assert.equal(calls[1].authorization, "Bearer secret-token");
assert.equal(calls[2].authorization, "Bearer secret-token");

const serialized = JSON.stringify(result);
assert.doesNotMatch(serialized, /secret-email|secret-password|secret-token/);
console.log("ERP authenticated validation call graph: PASS");
