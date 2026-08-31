import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/production-schema-pr827.yml");
const parsed = spawnSync("ruby", ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true))", workflowPath], { encoding: "utf8" });
assert.equal(parsed.status, 0, `workflow YAML must parse: ${parsed.stderr}`);
const workflow = JSON.parse(parsed.stdout);
const step = workflow.jobs.schema.steps.find(({ uses }) => uses === "appleboy/ssh-action@v1.2.0");

assert.ok(step, "the production SSH step must exist");
assert.equal(step.with.script_stop, undefined, "script_stop rewrites individual lines and corrupts compound Bash syntax");

const expression = /\$\{\{ inputs\.mode == 'apply' && format\('API_IMAGE=gest-o-api:\{0\}', github\.sha\) \|\| '' \}\}/g;
const cases = [
  ["legacy_build_only", "legacy_copy", "preview", "755_PROTECTED_BUNDLE_ROOT"],
  ["legacy_build_only", "legacy_copy", "apply", "755_PROTECTED_BUNDLE_ROOT"],
  ["invalid", "legacy_copy", "preview", "755_PROTECTED_BUNDLE_ROOT"],
  ["legacy_build_only", "invalid", "preview", "755_PROTECTED_BUNDLE_ROOT"],
  ["legacy_build_only", "legacy_copy", "invalid", "755_PROTECTED_BUNDLE_ROOT"],
  ["legacy_build_only", "legacy_copy", "preview", "755_PROTECTED_BUNDLE_ROOT"],
  ["legacy_build_only", "legacy_copy", "preview", "UNKNOWN"],
];

for (const [erpSource, pr827Source, mode, directoryMode] of cases) {
  const rendered = step.with.script.replace(expression, mode === "apply" ? "API_IMAGE=gest-o-api:0123456789abcdef" : "");
  assert.doesNotMatch(rendered, /\$\{\{/u, "all GitHub expressions in the remote script must be materialized");
  const checked = spawnSync("bash", ["-n"], { input: rendered, encoding: "utf8" });
  assert.equal(checked.status, 0, `remote Bash must parse (${erpSource}/${pr827Source}/${mode}/${directoryMode}): ${checked.stderr}`);
}

// appleboy's legacy script_stop implementation appended a status check after
// each physical line.  On the case header that produced `case ... in;`, which
// Bash reports at logical line 20 in the action-generated `bash -c` payload.
const caseHeader = step.with.script.split("\n").find((line) => /^case .* in$/u.test(line.trim()));
assert.ok(caseHeader, "the environment-source case header must remain explicit");
const invalidBefore = `${caseHeader};`;
const beforeCheck = spawnSync("bash", ["-n"], { input: `${invalidBefore}\nesac\n`, encoding: "utf8" });
assert.notEqual(beforeCheck.status, 0, "the exact pre-fix `in;` syntax must remain demonstrably invalid");

console.log("PR827 workflow remote script bash -n passed");
