import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const compose=read("docker-compose.production.yml"), deploy=read("scripts/deploy-production.sh"), pre=read("scripts/production-preflight.sh"), rollback=read("scripts/production-rollback.sh"), preview=read("scripts/production-schema-preview.sh"), envSource=read("apps/api/src/config/env.ts"), unit=read("docs/ops/gest-o.service"), workflow=read(".github/workflows/deploy-production.yml"), api=read("apps/api/src/app.ts");
assert.doesNotMatch(compose,/^\s{2}db:/m); assert.doesNotMatch(compose,/depends_on/);
assert.match(compose,/DATABASE_URL:\s*"\$\{DATABASE_URL:\?/); assert.match(compose,/external:\s*true/); assert.match(compose,/name: gest-o_default/);
assert.doesNotMatch(compose,/gest-o_pgdata/); assert.match(pre,/hostname do banco não autorizado/); assert.match(pre,/DATABASE_URL is required/);
assert.doesNotMatch(pre,/\/dev\/tcp/); assert.doesNotMatch(pre,/\bgetent\b/); assert.doesNotMatch(pre,/172\.18\.0\.2/);
assert.match(pre,/docker image inspect postgres:16/); assert.doesNotMatch(pre,/docker pull/);
assert.match(pre,/timeout "\$\{PRODUCTION_DB_READY_TIMEOUT_SECONDS:-15\}s"/);
assert.match(pre,/docker run --rm --pull=never/); assert.match(pre,/--network gest-o_default/);
assert.match(pre,/postgres:16\s+\\\s+pg_isready -h "\$DB_HOST" -p "\$DB_PORT" -d "\$DB_NAME"/);
const postgresProbe = pre.match(/timeout "\$\{PRODUCTION_DB_READY_TIMEOUT_SECONDS:-15\}s"[\s\S]*?pg_isready[^\n]*/)?.[0] ?? "";
assert.ok(postgresProbe); assert.doesNotMatch(postgresProbe,/DATABASE_URL|--publish|--volume|-v\s|--user|--password|-p\s+\d+:/);
for (const requiredCheck of ["PRODUCTION_DB_CONTAINER_EXPECTED","gest-o_default","PRODUCTION_DB_VOLUME_EXPECTED","PRODUCTION_BACKUP_FILE","sha256sum","git status --porcelain"]) assert.ok(pre.includes(requiredCheck),`preflight perdeu validação: ${requiredCheck}`);
assert.ok(deploy.indexOf('build api web') < deploy.indexOf('docker stop')); assert.match(deploy,/CONFIRM.*PRODUCTION_CUTOVER/); assert.match(deploy,/trap rollback ERR/);
assert.match(compose,/APP_COMMIT/); assert.match(compose,/APP_BUILT_AT/); assert.doesNotMatch(api,/environment: env\.nodeEnv/);
assert.match(compose,/image:\s*"\$\{API_IMAGE:\?/); assert.match(compose,/image:\s*"\$\{WEB_IMAGE:\?/);
assert.match(unit,/docker-compose\.production\.yml/); assert.doesNotMatch(workflow,/docker-compose\.yml/);
const composeVars = new Set([...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map(match => match[1]));
const runtimeVars = new Set([...envSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(match => match[1]));
const nonRuntimeAliases = new Set(["GIT_COMMIT","GITHUB_SHA","VERCEL_GIT_COMMIT_SHA","COMMIT_SHA","BUILD_TIMESTAMP","BUILT_AT","ACCESS_TOKEN_SECRET","REFRESH_TOKEN_SECRET"]);
const deliberatelyDisabledBootstrap = new Set(["ADMIN_BOOTSTRAP_ENABLED","ADMIN_BOOTSTRAP_NAME","ADMIN_BOOTSTRAP_EMAIL","ADMIN_BOOTSTRAP_PASSWORD","ADMIN_BOOTSTRAP_ROLE","ADMIN_BOOTSTRAP_REGION","SMOKE_DIRECTOR_EMAIL","SMOKE_DIRECTOR_PASSWORD","SMOKE_SELLER_EMAIL"]);
for (const variable of runtimeVars) if (!nonRuntimeAliases.has(variable) && !deliberatelyDisabledBootstrap.has(variable)) assert.ok(composeVars.has(variable),`Compose de produção omite ${variable} usado por config/env.ts`);
for (const variable of ["OPENAI_ENABLED","OPENAI_API_KEY","OPENAI_MODEL","FEATURE_ERP_INVESTIGATION"]) assert.ok(composeVars.has(variable),`Compose omite compatibilidade ${variable}`);
assert.doesNotMatch(rollback,/docker start/); assert.match(rollback,/API_ROLLBACK_IMAGE/); assert.match(rollback,/WEB_ROLLBACK_IMAGE/);
assert.ok(rollback.indexOf('stop api web') < rollback.indexOf('up -d --no-build'),"rollback deve parar novos antes de recriar antigos");
assert.match(rollback,/rm -f api web/); assert.match(rollback,/--force-recreate api web/); assert.match(rollback,/4000 5173/); assert.match(rollback,/\/health/);
assert.match(rollback,/API_ROLLBACK_IMAGE_ID/); assert.match(rollback,/WEB_ROLLBACK_IMAGE_ID/); assert.match(rollback,/PRODUCTION_DB_VOLUME_EXPECTED/);
assert.match(deploy,/gest-o-\$\{role\}-rollback:\$release/); assert.match(deploy,/previous-runtime\.tsv/); assert.match(deploy,/rollback-images\.env/);
assert.doesNotMatch(rollback,/compose[^\n]*(?:down|\bdb\b)/); assert.doesNotMatch(rollback,/docker\s+volume\s+rm|docker\s+compose[^\n]*(?:--volumes|\s-v(?:\s|$))/);
// Simula dois cutovers com o mesmo nome Compose: containers são substituídos,
// mas tags imutáveis continuam resolvendo os image IDs anteriores.
const images = new Map(), containers = new Map();
const cutover = (release, apiId, webId) => { images.set(`gest-o-api-rollback:${release}`, containers.get("api")); images.set(`gest-o-web-rollback:${release}`, containers.get("web")); containers.set("api", apiId); containers.set("web", webId); };
const restore = release => { containers.delete("api"); containers.delete("web"); containers.set("api", images.get(`gest-o-api-rollback:${release}`)); containers.set("web", images.get(`gest-o-web-rollback:${release}`)); };
containers.set("api","sha256:historical-api"); containers.set("web","sha256:historical-web"); cutover("historical","sha256:v1-api","sha256:v1-web"); restore("historical");
assert.equal(containers.get("api"),"sha256:historical-api"); assert.equal(containers.get("web"),"sha256:historical-web");
containers.set("api","sha256:v1-api"); containers.set("web","sha256:v1-web"); cutover("v1","sha256:v2-api","sha256:v2-web"); restore("v1");
assert.equal(containers.get("api"),"sha256:v1-api"); assert.equal(containers.get("web"),"sha256:v1-web");
assert.doesNotMatch(preview,/npx\s+prisma|npm\s+(install|i)\b|npx\s+--yes/); assert.match(preview,/gest-o-api:\$\{APP_COMMIT\}/); assert.match(preview,/\.\/node_modules\/\.bin\/prisma migrate diff/);
for (const [name,text] of [["compose",compose],["deploy",deploy],["preflight",pre],["rollback",rollback],["preview",preview],["unit",unit],["workflow",workflow]]) {
  for (const forbidden of ["down -v","volume rm","migrate reset","prisma:seed"]) assert.ok(!text.includes(forbidden),`${name} contém operação proibida`);
}
console.log("production deploy safety smoke passed");
