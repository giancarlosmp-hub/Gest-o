import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const compiled = `${root}/apps/api/dist/scripts/crmAuditErpClient.js`;
assert.ok(existsSync(compiled), `${compiled} deve existir após o build`);
const buildInfo = JSON.parse(readFileSync(`${root}/apps/api/dist/build-info.json`, "utf8"));
assert.deepEqual(Object.keys(buildInfo).sort(), ["builtAt", "commit", "version"]);
if (process.env.EXPECTED_APP_COMMIT) {
  assert.notEqual(buildInfo.commit, "unknown");
  assert.equal(buildInfo.commit, process.env.EXPECTED_APP_COMMIT);
}

const apiPackage = JSON.parse(readFileSync(`${root}/apps/api/package.json`, "utf8"));
assert.equal(apiPackage.scripts["crm:audit-erp-client:prod"], "node dist/scripts/crmAuditErpClient.js");

const invocation = spawnSync("npm", ["run", "crm:audit-erp-client:prod", "-w", "@salesforce-pro/api", "--"], {
  encoding: "utf8",
  cwd: root,
  env: { ...process.env, DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid" }
});
assert.equal(invocation.status, 1, "o comando sem --erp-code deve encerrar com status 1");
assert.match(invocation.stderr, /Informe --erp-code=<codigo>/);
assert.doesNotMatch(invocation.stderr, /postgresql:\/\//, "o smoke não deve revelar DATABASE_URL");

const service = readFileSync(`${root}/apps/api/src/services/erpClientAuditService.ts`, "utf8");
assert.match(service, /SET TRANSACTION READ ONLY/, "a auditoria deve impor transação read-only no PostgreSQL");
assert.match(service, /return runAudit\(options, tx\)/, "as consultas devem usar a transação read-only");

console.log("pr18a4 runtime smoke ok");
