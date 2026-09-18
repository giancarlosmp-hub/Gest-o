import { spawnSync } from 'node:child_process';

const waitForClose = (child, timeoutMs) => new Promise((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
  const onClose = (code, signal) => { clearTimeout(timer); resolve({ code, signal }); };
  const timer = setTimeout(() => { child.off('close', onClose); reject(new Error(`child_close_timeout timeout_ms=${timeoutMs}`)); }, timeoutMs);
  child.once('close', onClose);
});

export async function terminateAndWait(child, { timeoutMs = 3000 } = {}) {
  const closeDescriptors = () => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); };
  if (child.exitCode !== null || child.signalCode !== null) {
    closeDescriptors();
    return { code: child.exitCode, signal: child.signalCode };
  }
  child.kill('SIGTERM');
  try {
    return await waitForClose(child, timeoutMs);
  } catch (error) {
    child.kill('SIGKILL');
    try { await waitForClose(child, timeoutMs); } catch {}
    throw error;
  } finally {
    closeDescriptors();
  }
}

export function runBounded(command, args, { timeoutMs = 10000, ...options } = {}) {
  const result = spawnSync(command, args, { ...options, timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`teardown_command_timeout command=${command} timeout_ms=${timeoutMs}`);
  if (result.error) throw new Error(`teardown_command_failed_to_start command=${command} code=${result.error.code || 'unknown'}`);
  if (result.status !== 0) throw new Error(`teardown_command_failed command=${command} exit=${result.status} signal=${result.signal || 'none'}`);
  return result;
}
