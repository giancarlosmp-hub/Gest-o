import { readFile } from 'node:fs/promises';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitForReadyFile({ child, path, timeoutMs = 5000, pollMs = 20, stderr = () => '' }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, 'utf8')).trim();
      if (value) return value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`helper_exited_before_ready exit=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'none'} stderr=${stderr().trim() || 'empty'}`);
    }
    await delay(pollMs);
  }
  throw new Error(`helper_ready_timeout timeout_ms=${timeoutMs} stderr=${stderr().trim() || 'empty'}`);
}
