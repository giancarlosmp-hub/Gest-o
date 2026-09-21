import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const preview = readFileSync('docker-compose.preview.yml', 'utf8');
const base = readFileSync('docker-compose.yml', 'utf8');
const production = readFileSync('docker-compose.production.yml', 'utf8');
assert.match(preview, /x-preview-logging: &preview_logging\s+driver: json-file\s+options:\s+max-size: "25m"\s+max-file: "4"/);
for (const service of ['db', 'api', 'web']) {
  assert.match(preview, new RegExp(`\\n  ${service}:\\n    logging: \\*preview_logging`), `${service} must inherit bounded preview logging`);
}
assert.match(production, /x-production-logging: &production_logging\s+driver: json-file\s+options:\s+max-size: "25m"\s+max-file: "4"/);
for (const service of ['api', 'web']) {
  assert.match(production, new RegExp(`\\n  ${service}:\\n    logging: \\*production_logging`), `${service} must inherit bounded production logging`);
}
assert.doesNotMatch(base, /x-preview-logging|x-production-logging|max-size:\s*"25m"|max-file:\s*"4"/, 'preview/production log policy must not alter the local/CI base stack');
assert.doesNotMatch(preview, /max-size:\s*\$|max-file:\s*\$/, 'preview limits must not be weakened by environment overrides');
console.log('PREVIEW_LOG_ROTATION_SAFETY=PASS driver=json-file max_size=25m max_file=4 production_unchanged=pass');
