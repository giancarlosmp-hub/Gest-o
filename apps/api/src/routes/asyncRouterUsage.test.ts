import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Todo router da API nasce de createAsyncRouter: Router() direto volta a deixar erro async pendurado até o 408.
const routesDir = dirname(fileURLToPath(import.meta.url));
const routeFiles = readdirSync(routesDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const directRouter = /\bRouter\s*\(|express\.Router\s*\(/;

const offenders = routeFiles.filter((name) => directRouter.test(readFileSync(join(routesDir, name), "utf8")));
assert.deepEqual(offenders, [], `Use createAsyncRouter() em vez de Router(): ${offenders.join(", ")}`);

const usingAsyncRouter = routeFiles.filter((name) => readFileSync(join(routesDir, name), "utf8").includes("createAsyncRouter()"));
assert.ok(usingAsyncRouter.length >= 10, `esperados os 10 routers da API com createAsyncRouter (achados ${usingAsyncRouter.length})`);

console.log("asyncRouterUsage.test.ts: ok");
