import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const compose=read("docker-compose.production.yml"), deploy=read("scripts/deploy-production.sh"), pre=read("scripts/production-preflight.sh"), rollback=read("scripts/production-rollback.sh"), preview=read("scripts/production-schema-preview.sh"), envSource=read("apps/api/src/config/env.ts"), unit=read("docs/ops/gest-o.service"), workflow=read(".github/workflows/deploy-production.yml"), api=read("apps/api/src/app.ts");
assert.doesNotMatch(compose,/^\s{2}db:/m); assert.doesNotMatch(compose,/depends_on/);
assert.match(compose,/DATABASE_URL:\s*"\$\{DATABASE_URL:\?/); assert.match(compose,/external:\s*true/); assert.match(compose,/name: gest-o_default/);
assert.doesNotMatch(compose,/gest-o_pgdata/); assert.match(pre,/hostname do banco não autorizado/); assert.match(pre,/DATABASE_URL is required/);
assert.ok(deploy.indexOf('build api web') < deploy.indexOf('docker stop')); assert.match(deploy,/CONFIRM.*PRODUCTION_CUTOVER/); assert.match(deploy,/trap rollback ERR/);
assert.match(compose,/APP_COMMIT/); assert.match(compose,/APP_BUILT_AT/); assert.doesNotMatch(api,/environment: env\.nodeEnv/);
assert.match(unit,/docker-compose\.production\.yml/); assert.doesNotMatch(workflow,/docker-compose\.yml/);
const composeVars = new Set([...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map(match => match[1]));
const runtimeVars = new Set([...envSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(match => match[1]));
const nonRuntimeAliases = new Set(["GIT_COMMIT","GITHUB_SHA","VERCEL_GIT_COMMIT_SHA","COMMIT_SHA","BUILD_TIMESTAMP","BUILT_AT","ACCESS_TOKEN_SECRET","REFRESH_TOKEN_SECRET"]);
const deliberatelyDisabledBootstrap = new Set(["ADMIN_BOOTSTRAP_ENABLED","ADMIN_BOOTSTRAP_NAME","ADMIN_BOOTSTRAP_EMAIL","ADMIN_BOOTSTRAP_PASSWORD","ADMIN_BOOTSTRAP_ROLE","ADMIN_BOOTSTRAP_REGION","SMOKE_DIRECTOR_EMAIL","SMOKE_DIRECTOR_PASSWORD","SMOKE_SELLER_EMAIL"]);
for (const variable of runtimeVars) if (!nonRuntimeAliases.has(variable) && !deliberatelyDisabledBootstrap.has(variable)) assert.ok(composeVars.has(variable),`Compose de produção omite ${variable} usado por config/env.ts`);
for (const variable of ["OPENAI_ENABLED","OPENAI_API_KEY","OPENAI_MODEL","FEATURE_ERP_INVESTIGATION"]) assert.ok(composeVars.has(variable),`Compose omite compatibilidade ${variable}`);
assert.ok(rollback.indexOf('stop api web') < rollback.indexOf('docker start "$container"'),"rollback deve parar novos antes de iniciar antigos");
assert.match(rollback,/4000 5173/); assert.match(rollback,/\/health/); assert.match(rollback,/PRODUCTION_DB_VOLUME_EXPECTED/);
assert.doesNotMatch(preview,/npx\s+prisma|npm\s+(install|i)\b|npx\s+--yes/); assert.match(preview,/gest-o-api:\$\{APP_COMMIT\}/); assert.match(preview,/\.\/node_modules\/\.bin\/prisma migrate diff/);
for (const [name,text] of [["compose",compose],["deploy",deploy],["preflight",pre],["rollback",rollback],["preview",preview],["unit",unit],["workflow",workflow]]) {
  for (const forbidden of ["down -v","volume rm","migrate reset","prisma:seed"]) assert.ok(!text.includes(forbidden),`${name} contém operação proibida`);
}
console.log("production deploy safety smoke passed");
