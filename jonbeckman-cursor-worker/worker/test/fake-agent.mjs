// Test double for `agent`. Records the argv and the credential environment,
// prints the API key on stderr, and serves the management metrics port.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const record = {
  pid: process.pid,
  at: Date.now(),
  args,
  cursor: process.env.CURSOR_API_KEY || '',
  gh: process.env.GH_TOKEN || '',
  github: process.env.GITHUB_TOKEN || '',
};
if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify(record)}\n`);

console.error(`error ${process.env.CURSOR_API_KEY || ''}`);

const flag = args.indexOf('--management-addr');
const addr = flag >= 0 ? args[flag + 1] : '';
const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
const host = addr.slice(0, addr.lastIndexOf(':')) || '127.0.0.1';
const connected = process.env.FAKE_AGENT_CONNECTED !== '0';
const server = http.createServer((req, res) => {
  if (String(req.url || '').startsWith('/metrics')) {
    res.end(`cursor_self_hosted_worker_connected ${connected ? 1 : 0}\n`);
    return;
  }
  res.end('ok\n');
});
if (port) server.listen(port, host);

if (process.env.FAKE_AGENT_EXIT) {
  setTimeout(() => process.exit(Number(process.env.FAKE_AGENT_EXIT)), 40);
}

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
