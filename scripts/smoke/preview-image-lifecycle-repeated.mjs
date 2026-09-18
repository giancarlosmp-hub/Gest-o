import assert from 'node:assert/strict';
import { runSubprocessWithin } from './lib/run-subprocess-within.mjs';

for (let iteration = 1; iteration <= 2; iteration++) {
  console.log(`PREVIEW_IMAGE_DOCKER_ITERATION=${iteration}`);
  const result = await runSubprocessWithin(process.execPath, ['scripts/smoke/preview-image-lifecycle-docker.mjs'], { timeoutMs: 10 * 60 * 1000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.timedOut, false, `iteration ${iteration} did not terminate within 10 minutes`);
  assert.equal(result.signal, null, `iteration ${iteration} terminated by ${result.signal}`);
  assert.equal(result.code, 0, `iteration ${iteration} exit=${result.code}`);
  assert.equal((result.stdout.match(/^PREVIEW_IMAGE_DOCKER=PASS .*teardown=pass helper_exit=awaited$/gm) || []).length, 1, `iteration ${iteration} must publish one final PASS after teardown`);
}
console.log('PREVIEW_IMAGE_DOCKER_REPEATED=PASS iterations=2');
