import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../production-health-validation.sh", import.meta.url), "utf8");
const forbidden = [
  ["docker", "stop"], ["docker", "rm"], ["docker", "volume", "rm"],
  ["docker", "compose", "down"], ["docker", "compose", "up"],
  ["docker", "compose", "build"], ["docker", "system", "prune"],
  ["docker", "volume", "prune"], ["ps", "ql"], ["pg", "_restore"],
  ["migra", "tion"], ["se", "ed"], ["DATABASE", "_URL"], ["production", ".env"],
].map(parts => parts.join("\\s+"));

for (const pattern of forbidden) {
  assert.doesNotMatch(source, new RegExp(pattern, "i"), `ação/referência proibida: ${pattern}`);
}
for (const artifact of ["health", "runtime", "containers", "images", "network", "storage", "system", "security", "erp", "summary", "result"]) {
  assert.match(source, new RegExp(`\\b${artifact}\\b`), `artefato ausente: ${artifact}.tsv`);
}
assert.match(source, /trap 'rm -f "\$EVIDENCE_DIR\/result\.tsv"'/);
assert.match(source, /printf .* >"\$EVIDENCE_DIR\/result\.tsv"/);
console.log("production health validation safety: PASS");
