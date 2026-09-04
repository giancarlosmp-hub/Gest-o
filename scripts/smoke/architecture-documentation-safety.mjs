import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const architecture = read("docs/ARQUITETURA.md");
const master = read("docs/DOCUMENTO_MESTRE.md");
const ultra = read("docs/erp-ultrafv3-integration-technical.md");
const architectureIndex = read("docs/architecture/README.md");

assert.match(architecture, /Status \| \*\*AUTORITATIVO/);
assert.match(architecture, /Baseline Git revisada/);
assert.match(architecture, /```mermaid/);
assert.match(architecture, /## 26\. Integrações comprovadas/);
assert.match(master, /# Visão geral e arquitetura do Gest-o/);
assert.match(master, /\[\`docs\/ARQUITETURA\.md\`\]\(ARQUITETURA\.md\)/);
assert.match(master, /toda alteração que modifique componentes, integrações, contratos/i);
assert.match(ultra, /AUTORITATIVO — integração UltraFV3/);
assert.match(ultra, /CONNECTOR_TECHNOLOGY=WINDOWS_X64_WITH_EMBEDDED_NODEJS_RUNTIME/);
assert.match(ultra, /ULTRAFV3REST_TO_GESTAO_FIREBIRD_RELATIONSHIP=INFERRED_NOT_PROVEN/);
assert.match(ultra, /RAW_ERP_ARTIFACTS_MUST_NOT_BE_COMMITTED/);
assert.match(architectureIndex, /\.\.\/ARQUITETURA\.md/);

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const prohibitedArtifact = /(?:^|\/)(?:config\.json|\.aws\.env)$|\.(?:zip|7z|rar|exe|dll|vbs|crm|rem|fdb|fbk|bak|dump)$/i;
assert.deepEqual(
  tracked.filter((path) => prohibitedArtifact.test(path)),
  [],
  "artefato confidencial/proprietário não pode ser rastreado",
);

const authoritativeDocs = [architecture, master, ultra].join("\n");
assert.doesNotMatch(authoritativeDocs, /(?:password|senha|secret|token)\s*[=:]\s*["']?(?!<|\$|\*\*|não|somente)[^\s`"']{8,}/i);
assert.doesNotMatch(authoritativeDocs, /(?:file:\/\/|[A-Za-z]:\\|\/(?:tmp|home|workspace)\/)[^\s)`]+/);

console.log("Architecture documentation safety gate passed");
