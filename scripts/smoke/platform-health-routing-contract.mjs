import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("apps/api/src/app.ts", "utf8");
const client = readFileSync("apps/web/src/lib/platformHealthApi.ts", "utf8");
const apiClient = readFileSync("apps/web/src/lib/apiClient.ts", "utf8");
const vite = readFileSync("apps/web/vite.config.ts", "utf8");
const nginx = readFileSync("apps/web/nginx.conf", "utf8");
const shared = readFileSync("packages/shared/src/index.ts", "utf8");
assert.match(shared, /PLATFORM_HEALTH_API_PATH = "\/platform-health"/);
assert.match(client, /PLATFORM_HEALTH_API_PATH/);
assert.doesNotMatch(client, /\/api\/platform-health/, "feature client must not duplicate /api");
assert.match(apiClient, /return "\/api"/);
assert.match(vite, /"\/api".*target: "http:\/\/localhost:4000"/s);
assert.match(nginx, /proxy_pass http:\/\/api:4000;/, "container proxy must preserve /api");
assert.match(app, /\["\/platform-health", "\/api\/platform-health"\]/, "API must tolerate the legacy stripping host proxy");
assert.match(client, /safeParse\(response\.data\)/);
assert.match(client, /timeout: PLATFORM_HEALTH_TIMEOUT_MS/);
console.log("PLATFORM_HEALTH_ROUTING_CONTRACT=PASS");
