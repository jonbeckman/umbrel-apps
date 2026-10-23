// Git credential helper. Git reads the token from stdout. Nothing else is written.
import { readFileSync } from 'node:fs';
import { fillGitCredential } from './lib.mjs';

const file = process.env.CURSOR_WORKER_STATE || '/state/state.json';
let state = { owners: {} };
try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no credentials */ }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(fillGitCredential(input, state));
});
