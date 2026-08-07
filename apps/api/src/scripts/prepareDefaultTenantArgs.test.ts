import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parsePrepareDefaultTenantArgs } from "./prepareDefaultTenantArgs.js";

assert.deepEqual(parsePrepareDefaultTenantArgs(["--dry-run"]), { apply: false });
assert.deepEqual(parsePrepareDefaultTenantArgs(["--apply"]), { apply: true });

for (const args of [
  [],
  ["--foo"],
  ["--dry-run", "--apply"],
  ["--apply", "--dry-run"],
  ["--dry-run", "extra"],
  ["extra", "--apply"],
]) {
  assert.throws(
    () => parsePrepareDefaultTenantArgs(args),
    /usage: prepareDefaultTenant \[--dry-run\|--apply\]/,
    `expected rejection for ${JSON.stringify(args)}`,
  );
}

// Exercise the real entrypoint with Node's argv prefix. It must pass CLI parsing
// and stop at the next fail-closed gate without attempting a database connection.
const entrypoint = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/scripts/prepareDefaultTenant.ts", "--dry-run"],
  { cwd: process.cwd(), env: { ...process.env, TENANCY_MODE: "" }, encoding: "utf8" },
);
const entrypointOutput = `${entrypoint.stdout}${entrypoint.stderr}`;
assert.notEqual(entrypoint.status, 0);
assert.doesNotMatch(entrypointOutput, /usage: prepareDefaultTenant/);
assert.match(entrypointOutput, /TENANCY_MODE must be explicitly disabled or default-only/);

console.log("prepareDefaultTenant CLI argument tests passed");
