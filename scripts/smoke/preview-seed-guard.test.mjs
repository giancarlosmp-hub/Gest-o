import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Runs the real preview seed with unsafe environments and proves it refuses
// before touching any database. DATABASE_URL points to an unreachable port: a
// guard bypass would surface as a different error, never as the guard message.
const unreachablePreviewDatabaseUrl = "postgresql://preview_guard:unused@127.0.0.1:9/gesto_preview_guard?schema=public";
const guardKeys = ["ENABLE_PREVIEW_SEED", "DEPLOYMENT_ENV", "NODE_ENV", "DATABASE_URL", "PREVIEW_SEED_PASSWORD", "DEFAULT_TENANT_ID"];

const runSeed = (overrides) => {
  const env = { ...process.env };
  for (const key of guardKeys) delete env[key];
  Object.assign(env, { DATABASE_URL: unreachablePreviewDatabaseUrl, PREVIEW_SEED_PASSWORD: "guard-test-not-a-secret", DEFAULT_TENANT_ID: "tenant-default-v1" }, overrides);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, ["--import", "tsx", "apps/api/prisma/seedPreview.ts"], { env, encoding: "utf8", timeout: 60_000 });
};

const cases = [
  { name: "DEPLOYMENT_ENV ausente", env: { ENABLE_PREVIEW_SEED: "true", NODE_ENV: "development" }, message: "DEPLOYMENT_ENV=preview é obrigatório" },
  { name: "DEPLOYMENT_ENV=production", env: { ENABLE_PREVIEW_SEED: "true", NODE_ENV: "development", DEPLOYMENT_ENV: "production" }, message: "DEPLOYMENT_ENV=preview é obrigatório" },
  { name: "DEPLOYMENT_ENV=local", env: { ENABLE_PREVIEW_SEED: "true", NODE_ENV: "development", DEPLOYMENT_ENV: "local" }, message: "DEPLOYMENT_ENV=preview é obrigatório" },
  { name: "DEPLOYMENT_ENV=Preview (maiúscula)", env: { ENABLE_PREVIEW_SEED: "true", NODE_ENV: "development", DEPLOYMENT_ENV: "Preview" }, message: "DEPLOYMENT_ENV=preview é obrigatório" },
  { name: "ENABLE_PREVIEW_SEED ausente", env: { NODE_ENV: "development", DEPLOYMENT_ENV: "preview" }, message: "ENABLE_PREVIEW_SEED=true é obrigatório" },
  { name: "NODE_ENV=production", env: { ENABLE_PREVIEW_SEED: "true", NODE_ENV: "production", DEPLOYMENT_ENV: "preview" }, message: "Seed de preview bloqueado em NODE_ENV=production" },
  { name: "DATABASE_URL sem indício de preview", env: { ENABLE_PREVIEW_SEED: "true", NODE_ENV: "development", DEPLOYMENT_ENV: "preview", DATABASE_URL: "postgresql://guard:unused@127.0.0.1:9/gesto?schema=public" }, message: "DATABASE_URL não parece ser de preview" }
];

for (const testCase of cases) {
  const result = runSeed(testCase.env);
  assert.equal(result.error, undefined, `${testCase.name}: seed process failed to start`);
  assert.equal(result.status, 1, `${testCase.name}: seed must exit 1 (got ${result.status})`);
  assert.ok(result.stderr.includes(testCase.message), `${testCase.name}: expected guard message "${testCase.message}"\n${result.stderr}`);
  assert.ok(!/Preview seed concluído/.test(result.stdout), `${testCase.name}: seed must not report success`);
  console.log(`PREVIEW_SEED_GUARD_REFUSED=${testCase.name}`);
}

console.log("preview seed guard: PASS");
