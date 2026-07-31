import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const compose=read("docker-compose.production.yml"), deploy=read("scripts/deploy-production.sh"), pre=read("scripts/production-preflight.sh"), unit=read("docs/ops/gest-o.service"), workflow=read(".github/workflows/deploy-production.yml"), api=read("apps/api/src/app.ts");
assert.doesNotMatch(compose,/^\s{2}db:/m); assert.doesNotMatch(compose,/depends_on/);
assert.match(compose,/DATABASE_URL:\s*"\$\{DATABASE_URL:\?/); assert.match(compose,/external:\s*true/); assert.match(compose,/name: gest-o_default/);
assert.doesNotMatch(compose,/gest-o_pgdata/); assert.match(pre,/hostname do banco não autorizado/); assert.match(pre,/DATABASE_URL is required/);
assert.ok(deploy.indexOf('build api web') < deploy.indexOf('docker stop')); assert.match(deploy,/CONFIRM.*PRODUCTION_CUTOVER/); assert.match(deploy,/trap rollback ERR/);
assert.match(compose,/APP_COMMIT/); assert.match(compose,/APP_BUILT_AT/); assert.doesNotMatch(api,/environment: env\.nodeEnv/);
assert.match(unit,/docker-compose\.production\.yml/); assert.doesNotMatch(workflow,/docker-compose\.yml/);
for (const [name,text] of [["compose",compose],["deploy",deploy],["preflight",pre],["unit",unit],["workflow",workflow]]) {
  for (const forbidden of ["down -v","volume rm","migrate reset","prisma:seed"]) assert.ok(!text.includes(forbidden),`${name} contém operação proibida`);
}
console.log("production deploy safety smoke passed");
