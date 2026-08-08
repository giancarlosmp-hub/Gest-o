import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => fs.readFileSync(resolve(root, path), "utf8");
const resolver = read("apps/api/src/tenancy/tenantContext.ts");
const auth = read("apps/api/src/controllers/authController.ts");
const app = read("apps/api/src/app.ts");
const production = read("docker-compose.production.yml");
const workflow = read(".github/workflows/docker-compose-ci.yml");

assert.doesNotMatch(resolver, /tenant-default-v1|memberships\s*\[\s*0\s*\]|req\.(?:headers|body|query)|x-tenant-id/i);
assert.doesNotMatch(resolver, /(?:let|var)\s+(?:current|global|last)Tenant/i);
assert.match(resolver, /Object\.freeze/);
assert.match(resolver, /active\.length !== 1/);
assert.match(resolver, /legacy_default_only/);
assert.match(resolver, /tenant_claim/);
assert.match(auth, /const payload = \{ id: user\.id, email: user\.email, role: user\.role, region: user\.region \}/, "legacy JWT emission must remain unchanged");
assert.doesNotMatch(auth, /membershipRole|membershipId|contextVersion/);
assert.doesNotMatch(app, /resolveTenantContext|tenantContext/, "scaffolding must not change handlers or global middleware");
assert.match(production, /TENANCY_MODE:\s*disabled/);
assert.doesNotMatch(production, /TENANCY_MODE:\s*(?:default-only|enabled|tenant-aware)/);
assert.doesNotMatch(resolver, /console\.|logApiEvent|DATABASE_URL|\.password\b|\.email\b/);

for (const contract of ["createTenantContext", "TenantContextEvidence", "TrustedTenantPrincipal", "access_token", "webhook_account", "scheduler_job", "platform_break_glass", "requestId", "membershipVersion", "source", "tenantRole", "platformRole", "BREAK_GLASS_DENIED"]) {
  assert.ok(resolver.includes(contract), `additive legacy contract missing: ${contract}`);
}
const backfillGate = workflow.indexOf("- name: Prove tenancy backfill tooling on PostgreSQL 16");
const authGate = workflow.indexOf("- name: Prove TenantContext auth compatibility");
const generalSmoke = workflow.indexOf("- name: Prove synthetic PostgreSQL 16 backup restore");
assert.ok(backfillGate >= 0 && authGate > backfillGate && generalSmoke > authGate, "TenantContext auth gate must follow tenancy gates and precede general smokes");
const nextStep = workflow.indexOf("\n      - name:", authGate + 1);
assert.ok(nextStep > authGate, "TenantContext auth workflow step must be bounded");
const authStep = workflow.slice(authGate, nextStep);
assert.match(authStep, /run:\s*npm run test:tenant-context-auth(?:\s|$)/);
assert.doesNotMatch(authStep, /continue-on-error|\bif\s*:|SKIP|exit\s+77|\|\|\s*true/i);

console.log("tenant context auth static safety: PASS");
