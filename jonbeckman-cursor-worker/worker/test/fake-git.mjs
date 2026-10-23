// Test double for git. Records argv and, on a refused repo, prints the
// saved token to stderr the way a leaky git error might. Success paths
// do not print it.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_GIT_LOG) appendFileSync(process.env.FAKE_GIT_LOG, `${JSON.stringify(args)}\n`);

function tokens() {
  try {
    const state = JSON.parse(readFileSync(process.env.CURSOR_WORKER_STATE, 'utf8'));
    const values = [];
    if (state.cursorApiKey) values.push(state.cursorApiKey);
    for (const row of Object.values(state.owners || {})) if (row?.token) values.push(row.token);
    return values;
  } catch {
    return [];
  }
}

function refused(argv) {
  const spec = (process.env.FAKE_GIT_FAIL || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!spec.length) return false;
  const parts = new Set(argv.flatMap((arg) => String(arg).split(/[/\\]/)));
  return spec.some((repo) => argv.some((arg) => String(arg).includes(repo)) || parts.has(repo.split('/').pop()));
}

if (args.includes('config') || args.includes('set-url')) process.exit(0);

if (refused(args)) {
  const url = args.find((arg) => String(arg).startsWith('https://')) || args[args.length - 1];
  process.stderr.write(`fatal: Authentication failed for '${url}' ${tokens().join(' ')}\n`);
  process.exit(128);
}

if (args.includes('clone')) {
  const dest = args[args.length - 1];
  mkdirSync(path.join(dest, '.git'), { recursive: true });
  writeFileSync(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}
process.exit(0);
