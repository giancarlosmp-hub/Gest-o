import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tenancyRoot = join(root, "apps/api/src/tenancy");
const walk = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : join(directory, entry.name)))).flat();
const files = (await walk(tenancyRoot)).filter(file => [".ts", ".tsx"].includes(extname(file)) && !file.endsWith(".test.ts"));
const rules = [
  [/req\.(?:body|query)\??\.tenantId|req\.(?:body|query)\s*\[\s*["']tenantId/i, "tenantId supplied by body/query"],
  [/x-tenant-id/i, "free X-Tenant-Id header"],
  [/from\s+["']\.\.\/config\/prisma\.js["']/, "global Prisma in tenancy repository"],
];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const [pattern, label] of rules) assert(!pattern.test(source), `${label}: ${relative(root, file)}`);
  if (/Repository/.test(source)) assert(/TenantContext/.test(source), `repository without TenantContext: ${relative(root, file)}`);
}
const contracts = await readFile(join(tenancyRoot, "contracts.ts"), "utf8");
assert(/tenant:\$\{context\.tenantId\}/.test(contracts), "cache keys must be tenant namespaced");
assert(/TenantJobEnvelope<T>.*tenantId/s.test(contracts), "job envelopes must carry tenantId");
console.log(`tenancy architecture lint: PASS (${files.length} files)`);
