import { spawn } from 'node:child_process';
import { terminateAndWait } from './managed-process.mjs';

export async function runSubprocessWithin(command, args, { timeoutMs, env = process.env, cwd = process.cwd() }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => { timedOut = true; void terminateAndWait(child, { timeoutMs: 1000 }).catch(() => {}); }, timeoutMs);
  try {
    const result = await closed;
    return { ...result, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
