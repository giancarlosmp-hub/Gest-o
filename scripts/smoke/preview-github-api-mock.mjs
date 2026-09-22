import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const [modeFile, readyFile, delayRaw = '0'] = process.argv.slice(2);
const delayMs = Number(delayRaw);
if (!modeFile || !readyFile || !Number.isSafeInteger(delayMs) || delayMs < 0) {
  console.error('MOCK_SERVER_ERROR=invalid_arguments');
  process.exit(2);
}
if (process.env.PREVIEW_MOCK_FAIL_BEFORE_READY === 'true') {
  console.error('MOCK_SERVER_ERROR=forced_before_ready');
  process.exit(3);
}

const server = http.createServer((request, response) => {
  const mode = readFileSync(modeFile, 'utf8').trim();
  if (mode === 'error') {
    response.writeHead(503);
    response.end('{}');
    return;
  }
  let body;
  if (request.url.includes('/pulls?head=')) {
    if (mode === 'api_incomplete_response') {
      body = {};
    } else if (mode === 'paginated_ambiguous_page2') {
      const isPage2 = request.url.includes('page=2');
      body = isPage2
        ? [{ number: 99, head: { sha: 'c'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } } }]
        : Array.from({ length: 100 }, (_, i) => ({
            number: i === 0 ? 42 : i + 1000,
            head: { sha: 'b'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } }
          }));
    } else if (mode === 'branch_reuse_different_shas') {
      body = [
        { number: 10, head: { sha: '0'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } } },
        { number: 42, head: { sha: 'b'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } } }
      ];
    } else if (mode === 'ambiguous_multiple_prs') {
      body = [
        { number: 42, head: { sha: 'b'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } } },
        { number: 99, head: { sha: 'b'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } } }
      ];
    } else {
      body = [{ number: 42, head: { sha: 'b'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } } }];
    }
  } else if (request.url.includes('/pulls/')) {
    body = {
      state: mode === 'open' ? 'open' : 'closed',
      head: { sha: 'b'.repeat(40), ref: 'feature', user: { login: 'owner' }, repo: { full_name: 'owner/repo' } }
    };
  } else {
    const attemptMatch = request.url.match(/\/actions\/runs\/100\/attempts\/([0-9]+)$/);
    const topRunMatch = request.url.endsWith('/actions/runs/100');
    if (attemptMatch) {
      const requested = Number(attemptMatch[1]);
      body = {
        status: 'completed', conclusion: mode === 'cancelled' ? 'cancelled' : 'success',
        run_attempt: mode === 'attempt' ? requested + 1 : requested,
        head_sha: mode === 'head' ? 'c'.repeat(40) : 'b'.repeat(40), head_branch: 'feature', workflow_id: 7,
        name: 'Preview Deploy', path: mode === 'path' ? '.github/workflows/other.yml' : '.github/workflows/preview.yml',
        event: 'pull_request', pull_requests: []
      };
    } else if (topRunMatch) {
      body = {
        id: 100, head_sha: mode === 'head' ? 'c'.repeat(40) : 'b'.repeat(40),
        head_branch: mode === 'empty_prs_divergent_branch' ? 'divergent-branch' : 'feature',
        workflow_id: 7,
        name: 'Preview Deploy', path: mode === 'path' ? '.github/workflows/other.yml' : '.github/workflows/preview.yml',
        event: mode === 'empty_prs_push_event' ? 'push' : 'pull_request',
        pull_requests: mode === 'explicit_mismatched_pr'
          ? [{ number: 99, head: { sha: 'b'.repeat(40) } }]
          : (['empty_prs', 'empty_prs_divergent_branch', 'empty_prs_push_event', 'ambiguous_multiple_prs', 'paginated_ambiguous_page2', 'branch_reuse_different_shas', 'api_incomplete_response'].includes(mode)
            ? []
            : [{ number: 42, head: { sha: mode === 'head' ? 'c'.repeat(40) : 'b'.repeat(40) } }])
      };
    } else if (request.url.includes('/actions/workflows/7')) {
      body = { path: '.github/workflows/preview.yml' };
    } else {
      body = mode === 'incomplete' ? {} : { workflow_runs: [] };
    }
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
});
server.on('error', error => {
  console.error(`MOCK_SERVER_ERROR=listen_failed code=${error.code || 'unknown'}`);
  process.exitCode = 4;
});
const startupTimer = setTimeout(() => server.listen(0, '127.0.0.1', () => {
  writeFileSync(readyFile, `${server.address().port}\n`, { flag: 'wx' });
}), delayMs);
const shutdown = () => {
  clearTimeout(startupTimer);
  if (server.listening) server.close(() => { process.exitCode = 0; });
  else process.exitCode = 0;
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
