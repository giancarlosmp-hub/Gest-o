import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { waitForReadyFile } from './lib/wait-for-ready-file.mjs';
import { terminateAndWait } from './lib/managed-process.mjs';

const dir = mkdtempSync(join(tmpdir(), 'gesto-ready-file-'));
const mode = join(dir, 'mode');
writeFileSync(mode, 'ok');
const fixture = join(process.cwd(), 'scripts/smoke/preview-github-api-mock.mjs');
const start = ({ name, delay = 0, env = {}, timeoutMs = 1000 }) => {
  const ready = join(dir, `${name}.ready`);
  const child = spawn(process.execPath, [fixture, mode, ready, String(delay)], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, ready, stderr: () => stderr, timeoutMs };
};
const stop = child => terminateAndWait(child, { timeoutMs: 1000 });
try {
  for (const specification of [{ name: 'normal' }, { name: 'delayed', delay: 120 }]) {
    const running = start(specification);
    const port = await waitForReadyFile({ child: running.child, path: running.ready, timeoutMs: running.timeoutMs, stderr: running.stderr });
    assert.match(port, /^[0-9]+$/);
    await stop(running.child);
  }
  const failed = start({ name: 'failed', env: { PREVIEW_MOCK_FAIL_BEFORE_READY: 'true' } });
  await assert.rejects(waitForReadyFile({ child: failed.child, path: failed.ready, timeoutMs: 1000, stderr: failed.stderr }), /helper_exited_before_ready exit=3.*forced_before_ready/);
  const timedOut = start({ name: 'timeout', delay: 500 });
  await assert.rejects(waitForReadyFile({ child: timedOut.child, path: timedOut.ready, timeoutMs: 50, stderr: timedOut.stderr }), /helper_ready_timeout timeout_ms=50/);
  await stop(timedOut.child);
  console.log('PREVIEW_HELPER_READINESS=PASS normal=pass delayed=pass early_exit=pass timeout=pass');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
