import assert from 'node:assert/strict';
import { runSubprocessWithin } from './lib/run-subprocess-within.mjs';

const success = await runSubprocessWithin(process.execPath, ['-e', "console.log('PASS')"], { timeoutMs: 1000 });
assert.deepEqual({ code: success.code, signal: success.signal, timedOut: success.timedOut }, { code: 0, signal: null, timedOut: false });
assert.match(success.stdout, /^PASS\n$/);
const failure = await runSubprocessWithin(process.execPath, ['-e', "console.error('EXPECTED_FAIL');process.exitCode=7"], { timeoutMs: 1000 });
assert.equal(failure.code, 7);
assert.equal(failure.timedOut, false);
assert.match(failure.stderr, /EXPECTED_FAIL/);
const timeout = await runSubprocessWithin(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 });
assert.equal(timeout.timedOut, true);
assert.ok(timeout.signal || timeout.code !== 0);
console.log('PREVIEW_SUBPROCESS_EXIT_REGRESSION=PASS success_exit=0 failure_exit=7 timeout_terminated=pass');
