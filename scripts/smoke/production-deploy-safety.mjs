import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const compose=read("docker-compose.production.yml"), deploy=read("scripts/deploy-production.sh"), pre=read("scripts/production-preflight.sh"), rollback=read("scripts/production-rollback.sh"), preview=read("scripts/production-schema-preview.sh"), envSource=read("apps/api/src/config/env.ts"), unit=read("docs/ops/gest-o.service"), workflow=read(".github/workflows/deploy-production.yml"), api=read("apps/api/src/app.ts");
const erpEnvPreflight=read("scripts/erp-production-env-preflight.sh");
const envResolver=read("scripts/resolve-production-env.sh");
const entrypoint=read("scripts/production-deploy-entrypoint.sh");
assert.match(deploy, /if ENV_FILE="\$\(MODE="\$MODE" bash scripts\/resolve-production-env\.sh\)"/);
assert.match(workflow, /production-deploy-entrypoint\.sh/);
assert.doesNotMatch(workflow, /test "\$\(git rev-parse HEAD\)"/);
for (const marker of ["DEPLOY_GIT_FETCH", "DEPLOY_GIT_SWITCH", "DEPLOY_GIT_FAST_FORWARD", "DEPLOY_EXPECTED_SHA_FORMAT", "DEPLOY_CHECKOUT_SHA_MATCH", "DEPLOY_WORKTREE_CLEAN", "DEPLOY_SCRIPT_PRESENT", "DEPLOY_SCRIPT_STARTING"]) assert.ok(entrypoint.includes(marker));
for (const text of [entrypoint, workflow]) {
  assert.doesNotMatch(text, /set -x|\beval\b|\|\| true/);
}
assert.match(envResolver, /ERP_PRODUCTION_ENV_SOURCE=canonical/);
assert.match(envResolver, /ERP_PRODUCTION_ENV_SOURCE=legacy_build_only/);
assert.match(envResolver, /canonical source is required for cutover/);
assert.ok(envResolver.indexOf('validate "$CANONICAL_ENV_FILE" canonical') < envResolver.indexOf('validate "$LEGACY_ENV_FILE" legacy_build_only'));
assert.match(deploy, /ERP_ENV_SCHEDULER_POLICY=disabled_build_only/);
assert.doesNotMatch(envResolver, /\b(?:cp|mv|install|sed|awk)\b/);
assert.ok(deploy.indexOf("erp-production-env-preflight.sh") < deploy.indexOf("production-preflight.sh"));
assert.match(deploy, /PRODUCTION_PREFLIGHT_MODE="\$MODE" bash scripts\/production-preflight\.sh/);
assert.match(pre, /build\|cutover/);
for (const marker of ["PRODUCTION_PREFLIGHT_MODE", "PRODUCTION_BACKUP_PRESENCE", "PRODUCTION_BACKUP_INTEGRITY", "PRODUCTION_BACKUP_FRESHNESS", "PRODUCTION_PREFLIGHT=PASS"]) assert.ok(pre.includes(marker));
for (const reason of ["backup_missing", "backup_integrity", "backup_stale", "invalid_preflight_mode"]) assert.ok(pre.includes(reason));
assert.match(compose, /ERP_SYNC_SCHEDULER_ENABLED: "\$\{ERP_SYNC_SCHEDULER_ENABLED:\?/);
for (const policy of ["TENANCY_MODE disabled", "TENANT_READ_PILOT_ENABLED false", "DATABASE_SCHEMA_MODE external", "SEED_ON_BOOTSTRAP false", "ENABLE_PREVIEW_SEED false", "ENABLE_SMOKE_BOOTSTRAP false"]) {
  const [name, value] = policy.split(" ");
  assert.ok(erpEnvPreflight.includes(`require_literal ${name} ${value}`));
}
assert.doesNotMatch(erpEnvPreflight, /echo[^\n]*\$\{?!name|printf[^\n]*\$\{?!name/);
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
assert.match(deploy,/actual_services="\$\("\$\{COMPOSE\[@\]\}" config --services \| sort\)"/);
assert.match(deploy,/expected_services="\$\(printf 'api\\nweb\\n' \| sort\)"/);
assert.match(deploy,/\[\[ "\$actual_services" == "\$expected_services" \]\] \|\| die "topologia contém serviços inesperados"/);
assert.doesNotMatch(deploy,/config --services \|\s*diff/);
const acceptsComposeServices = services => spawnSync("bash", ["-c", `
  actual_services="$(printf '%s\\n' "$@" | sort)"
  expected_services="$(printf 'api\\nweb\\n' | sort)"
  [[ "$actual_services" == "$expected_services" ]]
`, "production-topology-test", ...services]).status === 0;
assert.equal(acceptsComposeServices(["api", "web"]), true);
assert.equal(acceptsComposeServices(["web", "api"]), true);
for (const services of [["api", "web", "db"], ["api", "web", "worker"], ["api"], ["web"]]) {
  assert.equal(acceptsComposeServices(services), false, `topologia inválida aceita: ${services.join(", ")}`);
}
assert.ok(deploy.indexOf('build api web') < deploy.indexOf('docker stop')); assert.match(deploy,/CONFIRM.*PRODUCTION_CUTOVER/); assert.match(deploy,/trap rollback ERR/);
assert.ok(deploy.includes("tr -cd '[:alnum:]._ -'")); assert.ok(!deploy.includes("tr -cd '[:alnum:]._- '"));
assert.match(deploy,/git diff --quiet "\$SCHEMA_EVIDENCE_COMMIT" "\$APP_COMMIT" -- apps\/api\/prisma/);
assert.match(deploy,/git show "\$evidence_commit:\$schema_migration" \| sha256sum/);
assert.match(deploy,/post-apply-diff\.sql" && ! -s "\$evidence_dir\/post-apply-diff\.sql/);
assert.match(deploy,/schema-diff-filter\.mjs "\$schema_validation_tmp\/raw\.sql" "\$schema_validation_tmp\/managed\.sql" post/);
assert.match(deploy,/\[\[ ! -s "\$schema_validation_tmp\/managed\.sql" \]\]/);
const allowlistCase = deploy.match(/is_schema_evidence_operational_path\(\)\{[\s\S]*?\n\}/)?.[0] ?? "";
assert.ok(allowlistCase, "função da allowlist operacional ausente");
const operationalAllowlist = [
  "scripts/deploy-production.sh",
  "scripts/production-rollback.sh",
  "scripts/smoke/production-deploy-safety.mjs",
  "docs/DEPLOY_GUIDE.md",
  "docs/OPERACAO.md",
  "docs/STATUS_ATUAL.md",
  "docs/DOCUMENTO_MESTRE.md",
  "docs/investigations/production-schema-transition-july-2026.md",
];
const casePaths = (allowlistCase.match(/^    (.+)\) return 0 ;;$/m)?.[1] ?? "").split("|");
assert.deepEqual(casePaths, operationalAllowlist, "allowlist deve conter somente os oito caminhos exatos");
for (const path of operationalAllowlist) assert.ok(casePaths.includes(path), `allowlist rejeitou ${path}`);
for (const path of [
  "apps/api/src/app.ts",
  "apps/web/src/App.tsx",
  "apps/api/prisma/schema.prisma",
  "apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql",
  "package.json",
  "docker-compose.production.yml",
  ".github/workflows/deploy-production.yml",
]) assert.ok(!casePaths.includes(path), `allowlist aceitou caminho proibido: ${path}`);
assert.match(deploy,/log "evidência rejeitada: arquivos fora da allowlist:"/);
assert.match(deploy,/printf '%s\\n' "\$blocked_paths" >&2/);
assert.ok(deploy.indexOf('nenhuma evidência equivalente de schema foi validada') < deploy.indexOf('docker stop'));
const sanitizeRelease = value => spawnSync("sh", ["-c", "printf '%s' \"$1\" | tr -cd '[:alnum:]._ -' | tr ' ' '-' | cut -c1-40", "sanitize-release", value], { encoding: "utf8" });
for (const [input, expected] of [["abc/def ghi", "abcdef-ghi"], ["sha256:abc", "sha256abc"], ["release_1.2-x", "release_1.2-x"]]) {
  const result = sanitizeRelease(input); assert.equal(result.status, 0); assert.equal(result.stdout, `${expected}\n`);
}
assert.match(deploy,/"\$\{COMPOSE\[@\]\}" build api web/); assert.doesNotMatch(deploy,/"\$\{COMPOSE\[@\]\}" build (?:db|worker)/);
assert.match(compose,/APP_COMMIT/); assert.match(compose,/APP_BUILT_AT/); assert.doesNotMatch(api,/environment: env\.nodeEnv/);
assert.match(compose,/image:\s*"\$\{API_IMAGE:\?/); assert.match(compose,/image:\s*"\$\{WEB_IMAGE:\?/);
assert.match(unit,/docker-compose\.production\.yml/); assert.doesNotMatch(workflow,/docker-compose\.yml/);
const composeVars = new Set([...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map(match => match[1]));
const runtimeVars = new Set([...envSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(match => match[1]));
const nonRuntimeAliases = new Set(["GIT_COMMIT","GITHUB_SHA","VERCEL_GIT_COMMIT_SHA","COMMIT_SHA","BUILD_TIMESTAMP","BUILT_AT","ACCESS_TOKEN_SECRET","REFRESH_TOKEN_SECRET"]);
const deliberatelyDisabledBootstrap = new Set(["ADMIN_BOOTSTRAP_ENABLED","ADMIN_BOOTSTRAP_NAME","ADMIN_BOOTSTRAP_EMAIL","ADMIN_BOOTSTRAP_PASSWORD","ADMIN_BOOTSTRAP_ROLE","ADMIN_BOOTSTRAP_REGION","SMOKE_DIRECTOR_EMAIL","SMOKE_DIRECTOR_PASSWORD","SMOKE_SELLER_EMAIL"]);
for (const variable of runtimeVars) if (!nonRuntimeAliases.has(variable) && !deliberatelyDisabledBootstrap.has(variable)) assert.ok(composeVars.has(variable),`Compose de produção omite ${variable} usado por config/env.ts`);
for (const variable of ["OPENAI_ENABLED","OPENAI_API_KEY","OPENAI_MODEL","FEATURE_ERP_INVESTIGATION"]) assert.ok(composeVars.has(variable),`Compose omite compatibilidade ${variable}`);
assert.match(rollback,/docker start "\$container_id"/); assert.match(rollback,/API_ROLLBACK_IMAGE/); assert.match(rollback,/WEB_ROLLBACK_IMAGE/);
assert.ok(rollback.indexOf('stop api web') < rollback.indexOf('up -d --no-build'),"rollback deve parar novos antes de recriar antigos");
assert.match(rollback,/rm -f api web/); assert.match(rollback,/--force-recreate "\$role"/); assert.match(rollback,/4000 5173/); assert.match(rollback,/\/health/);
assert.match(rollback,/restaurado não usa o image ID anterior/); assert.match(rollback,/PRODUCTION_DB_VOLUME_EXPECTED/);
assert.match(deploy,/gest-o-\$\{role\}-rollback:\$release/); assert.match(deploy,/previous-runtime\.tsv/); assert.match(deploy,/rollback-images\.env/);
assert.match(deploy,/role\\trollback_mode\\tcontainer_name\\tcontainer_id\\timage_id\\trollback_tag\\tport\\tnetworks\\trestart_policy\\tprevious_commit/);
assert.match(deploy,/rollback-containers\.tsv/);
assert.match(deploy,/docker image inspect "\$image_id"/); // imagem disponível -> modo image
assert.match(deploy,/rollback_mode=container/); // API ou WEB históricos podem usar container
assert.match(deploy,/compose_project.*com\.docker\.compose\.project/);
assert.match(deploy,/"\$compose_project" != gest-o-production/); // ausência de imagem no projeto atual falha fechada
assert.match(deploy,/docker inspect "\$container_id" >"\$evidence\/\$role\.previous\.inspect\.json"/);
assert.doesNotMatch(deploy,/docker rm[^\n]*\$container_id/); // container histórico é apenas parado
assert.ok(deploy.indexOf('bash -n "$evidence/rollback.sh"') < deploy.indexOf('docker stop "$container_id"'));
assert.ok(deploy.indexOf('evidência incompleta para $role') < deploy.indexOf('docker stop "$container_id"'));
assert.match(deploy,/\.aborted-\$\(date -u/); assert.match(deploy,/mv "\$evidence" "\$aborted"/);
assert.match(deploy,/install -d -m 700/); assert.match(deploy,/chmod 600/);
assert.match(rollback,/"\$recorded" == "\$name\|\$container_id"/); // inicia e reconfirma o ID exato
assert.match(rollback,/\$container_id\|true/);
assert.doesNotMatch(rollback,/compose[^\n]*(?:down|\bdb\b)/); assert.doesNotMatch(rollback,/docker\s+volume\s+rm|docker\s+compose[^\n]*(?:--volumes|\s-v(?:\s|$))/);
for (const [name,text] of [["deploy",deploy],["resolver",envResolver],["rollback",rollback]]) {
  assert.doesNotMatch(text,/docker\s+commit/);
  assert.doesNotMatch(text,/docker\s+(?:container\s+)?rm[^\n]*(?:histor|container_id)/);
  assert.doesNotMatch(text,/docker\s+(?:stop|rm)[^\n]*(?:postgres|PRODUCTION_DB)/i);
  assert.doesNotMatch(text,/docker\s+volume\s+(?:rm|prune)/);
}
// Simula dois cutovers com o mesmo nome Compose: containers são substituídos,
// mas tags imutáveis continuam resolvendo os image IDs anteriores.
const images = new Map(), containers = new Map();
const cutover = (release, apiId, webId) => { images.set(`gest-o-api-rollback:${release}`, containers.get("api")); images.set(`gest-o-web-rollback:${release}`, containers.get("web")); containers.set("api", apiId); containers.set("web", webId); };
const restore = release => { containers.delete("api"); containers.delete("web"); containers.set("api", images.get(`gest-o-api-rollback:${release}`)); containers.set("web", images.get(`gest-o-web-rollback:${release}`)); };
containers.set("api","sha256:historical-api"); containers.set("web","sha256:historical-web"); cutover("historical","sha256:v1-api","sha256:v1-web"); restore("historical");
assert.equal(containers.get("api"),"sha256:historical-api"); assert.equal(containers.get("web"),"sha256:historical-web");
containers.set("api","sha256:v1-api"); containers.set("web","sha256:v1-web"); cutover("v1","sha256:v2-api","sha256:v2-web"); restore("v1");
assert.equal(containers.get("api"),"sha256:v1-api"); assert.equal(containers.get("web"),"sha256:v1-web");
// Primeiro cutover aceita modos por role e os posteriores continuam usando imagem.
const mechanisms = (apiImage, webImage, apiExternal=true, webExternal=true) => ({
  api: apiImage ? "image" : apiExternal ? "container" : "fail-closed",
  web: webImage ? "image" : webExternal ? "container" : "fail-closed",
});
assert.deepEqual(mechanisms(true,true), {api:"image",web:"image"});
assert.deepEqual(mechanisms(false,true), {api:"container",web:"image"});
assert.deepEqual(mechanisms(true,false), {api:"image",web:"container"});
assert.deepEqual(mechanisms(false,false), {api:"container",web:"container"});
assert.equal(mechanisms(false,true,false).api,"fail-closed");
assert.doesNotMatch(preview,/npx\s+prisma|npm\s+(install|i)\b|npx\s+--yes/); assert.match(preview,/gest-o-api:\$\{APP_COMMIT\}/); assert.match(preview,/\.\/node_modules\/\.bin\/prisma migrate diff/);
for (const [name,text] of [["compose",compose],["deploy",deploy],["preflight",pre],["rollback",rollback],["preview",preview],["unit",unit],["workflow",workflow]]) {
  for (const forbidden of ["down -v","volume rm","migrate reset","prisma:seed"]) assert.ok(!text.includes(forbidden),`${name} contém operação proibida`);
}
console.log("production deploy safety smoke passed");
