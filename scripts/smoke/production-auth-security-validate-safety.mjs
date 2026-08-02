import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../production-auth-security-validate.sh", import.meta.url), "utf8");
for (const pattern of [
  /docker\s+compose\s+build/, /docker\s+compose\s+up/, /docker\s+stop/, /docker\s+rm/,
  /docker\s+volume\s+rm/, /docker\s+compose\s+down/, /\bpsql\b/, /\bpg_restore\b/,
  /prisma\s+db\s+push/, /\bmigration\b/i, /\bseed\b/i,
  />+\s*[^\n]*production\.env|(?:tee|install|cp|mv)\s+[^\n]*production\.env/,
]) assert.doesNotMatch(source, pattern, `operação proibida encontrada: ${pattern}`);

for (const pattern of [
  /EXPECTED_SHA:\?EXPECTED_SHA is required/, /PRODUCTION_AUTH_SECURITY_VALIDATE/,
  /git rev-parse origin\/main/, /git status --porcelain/, /\/debug\/admin\//,
  /auth_login_success/, /auth_login_failure/, /--since "\$STARTED_AT"/,
  /metadata\.tsv/, /runtime\.tsv/, /api-version\.json/, /web-build-info\.json/,
  /endpoint-results\.tsv/, /login-results\.tsv/, /log-scan-results\.tsv/, /result\.tsv/,
]) assert.match(source, pattern);
assert.ok(source.lastIndexOf('>"$EVIDENCE_DIR/result.tsv"') > source.indexOf('log-scan-results.tsv'));
assert.doesNotMatch(source, /console\.log\([^\n]*\$\{(?:email|password|token)\}/i);
assert.doesNotMatch(source, /docker logs[^\n]*>\s*["']?[^&\s]/, "logs brutos não podem ser redirecionados");
console.log("PASS: validação pós-deploy é read-only e preserva somente evidência sanitizada");
