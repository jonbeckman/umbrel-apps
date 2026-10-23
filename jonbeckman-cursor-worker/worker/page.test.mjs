import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('./test/fake-agent.mjs', import.meta.url));
const FAKE_GIT = fileURLToPath(new URL('./test/fake-git.mjs', import.meta.url));
const pat = (char) => `github_pat_${char.repeat(22)}`;

function listenPort() {
  return import('node:net').then((net) => new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  }));
}

function scriptPolicy(csp) {
  const dirs = new Map();
  for (const part of String(csp || '').split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length) dirs.set(bits[0], bits.slice(1));
  }
  return dirs.get('script-src') || dirs.get('default-src') || [];
}

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((match) => {
    const hasSrc = /\bsrc\s*=\s*["'][^"']+["']/.test(match[1]);
    return !hasSrc || match[2].trim().length > 0;
  });
}

function githubServer(validToken) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization || '';
      if (!auth.includes(validToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      const url = req.url || '/';
      if (url === '/user') {
        res.end(JSON.stringify({ login: 'jonbeckman' }));
        return;
      }
      if (url === '/orgs/SolZeroAI' || url === '/users/jonbeckman') {
        res.end(JSON.stringify({ login: url.split('/').pop() }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withServer(extra, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cursor-page-'));
  const port = await listenPort();
  const metrics = await listenPort();
  const home = path.join(dir, 'home');
  const stateDir = path.join(dir, 'state');
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      MANAGEMENT_ADDR: `127.0.0.1:${metrics}`,
      STATE_DIR: stateDir,
      CURSOR_WORKER_STATE: path.join(stateDir, 'state.json'),
      WORKSPACES_DIR: path.join(dir, 'workspaces'),
      HOME: home,
      AGENT_NODE_SCRIPT: FAKE_AGENT,
      GIT_NODE_SCRIPT: FAKE_GIT,
      FAKE_AGENT_LOG: path.join(dir, 'agent.log'),
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      APP_PROXY_HOST: '',
      WORKER_AUTOSTART: '0',
      WORKER_BACKOFF_BASE_MS: '40',
      METRICS_POLL_MS: '40',
      WORKER_STOP_MS: '300',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`${base}/healthz`);
        if (res.ok) { up = true; break; }
      } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(up, true, logs.join(''));
    await fn({ base, logs, dir, stateDir });
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill('SIGKILL');
    const agentLog = await readFile(path.join(dir, 'agent.log'), 'utf8').catch(() => '');
    for (const line of agentLog.split('\n')) {
      if (!line) continue;
      try { process.kill(JSON.parse(line).pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function disk(dir) {
  const out = [];
  async function walk(current) {
    const names = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const name of names) {
      const full = path.join(current, name.name);
      if (name.isDirectory()) await walk(full);
      else if (name.name !== 'agent.log') out.push(await readFile(full, 'utf8').catch(() => ''));
    }
  }
  await walk(dir);
  return out.join('\n');
}

test('served setup page has no inline script and posts the form', async () => {
  const docker = await readFile(fileURLToPath(new URL('./Dockerfile', import.meta.url)), 'utf8');
  assert.match(docker, /page\.js/);
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    const csp = res.headers.get('content-security-policy');
    assert.equal(res.status, 200);
    assert.equal(inlineScripts(html).length, 0);
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(html), false);
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
    assert.deepEqual(srcs, ['/page.js']);
    const policy = scriptPolicy(csp);
    assert.ok(policy.includes("'self'"));
    assert.equal(policy.includes("'unsafe-inline'"), false);
    assert.equal(policy.includes("'unsafe-eval'"), false);
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    assert.match(form, /\bmethod\s*=\s*["']post["']/i);
    assert.match(form, /\baction\s*=\s*["']\/api\/save["']/i);
    assert.match(form, /name="cursorApiKey"/);
    assert.match(form, /type="password"/);
    assert.match(form, /name="tokenSolZeroAI"/);
    assert.match(form, /name="tokenJonbeckman"/);
    assert.match(form, /Save and Restart/);
    assert.equal(/\bmethod\s*=\s*["']get["']/i.test(form), false);

    const js = await fetch(`${base}/page.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const code = await js.text();
    const refresh = code.slice(code.indexOf('async function refresh()'), code.indexOf('// end refresh'));
    assert.equal(refresh.includes('notice'), false);
    assert.match(code, /preventDefault/);
    assert.match(code, /Saved\. Key saved\. The worker is restarting\./);
    assert.match(code, /\/api\/save/);
    assert.match(code, /\/api\/status/);
    assert.equal(scriptPolicy(js.headers.get('content-security-policy')).includes("'unsafe-inline'"), false);
  });
});

test('secrets never appear in the status API or logs', async () => {
  const cursorKey = 'cursor_test_key_9f3a7c1e';
  const token = pat('q');
  const leaked = pat('z');
  const classic = `ghp_${'c'.repeat(20)}`;
  const ambient = pat('m');
  const github = await githubServer(token);
  const githubPort = github.address().port;
  try {
    await withServer({
      GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
      GH_TOKEN: ambient,
      GITHUB_TOKEN: ambient,
    }, async ({ base, logs, dir, stateDir }) => {
      const query = await fetch(`${base}/api/save?cursorApiKey=${encodeURIComponent(cursorKey)}&token=${encodeURIComponent(leaked)}`);
      const queryBody = await query.text();
      assert.equal(query.status, 400);
      assert.equal(queryBody.includes(cursorKey), false);
      assert.equal(queryBody.includes(leaked), false);
      assert.match(queryBody, /query string/);
      assert.equal(logs.join('').includes(cursorKey), false);
      assert.equal(logs.join('').includes(leaked), false);
      assert.equal(/token=/i.test(logs.join('')), false);

      const form = await fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-GHR-Request': '1' },
        body: `cursorApiKey=${encodeURIComponent(cursorKey)}&token=${encodeURIComponent(leaked)}`,
      });
      const formBody = await form.text();
      assert.equal(form.status, 400);
      assert.equal(formBody.includes(cursorKey), false);
      assert.equal(formBody.includes(leaked), false);
      assert.match(formBody, /Expected JSON/);

      const bare = await fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursorApiKey: cursorKey, owners: [], repos: 'SolZeroAI/janus' }),
      });
      assert.equal(bare.status, 403);
      assert.equal((await bare.text()).includes(cursorKey), false);

      const wrong = await fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
        body: JSON.stringify({ cursorApiKey: classic, owners: [], repos: 'SolZeroAI/janus' }),
      });
      const wrongBody = await wrong.text();
      assert.equal(wrong.status, 400);
      assert.equal(wrongBody.includes(classic), false);

      const saved = await fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
        body: JSON.stringify({
          cursorApiKey: cursorKey,
          owners: [
            { owner: 'SolZeroAI', token },
            { owner: 'jonbeckman', token: '' },
          ],
          repos: 'SolZeroAI/janus\njonbeckman/spray\n',
        }),
      });
      const savedBody = await saved.text();
      assert.equal(saved.status, 200, savedBody);
      assert.equal(savedBody.includes(cursorKey), false);
      assert.equal(savedBody.includes(token), false);
      assert.equal(savedBody.includes(leaked), false);
      assert.equal(savedBody.includes(ambient), false);
      const savedJson = JSON.parse(savedBody);
      assert.equal(savedJson.cursorKey, 'key saved');
      assert.equal(savedJson.owners.find((row) => row.owner === 'SolZeroAI').token, 'token saved');

      const file = path.join(stateDir, 'state.json');
      const mode = (await stat(file)).mode & 0o777;
      assert.equal(mode, 0o600);
      const stored = await readFile(file, 'utf8');
      assert.equal(stored.includes(cursorKey), true);
      assert.equal(stored.includes(token), true);
      assert.equal(stored.includes(leaked), false);

      let statusText = '';
      for (let i = 0; i < 50; i += 1) {
        statusText = await (await fetch(`${base}/api/status`)).text();
        if (logs.join('').includes('[redacted]')) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(statusText.includes(cursorKey), false);
      assert.equal(statusText.includes(token), false);
      assert.equal(statusText.includes(ambient), false);
      assert.equal(statusText.includes(leaked), false);
      const status = JSON.parse(statusText);
      assert.equal(status.cursorKey, 'key saved');
      assert.equal(typeof status.worker.running, 'boolean');
      assert.equal(typeof status.worker.connected, 'boolean');

      const text = logs.join('');
      assert.equal(text.includes(cursorKey), false);
      assert.equal(text.includes(token), false);
      assert.equal(text.includes(ambient), false);
      assert.equal(text.includes(leaked), false);
      assert.match(text, /\[redacted\]/);

      const agentLog = await readFile(path.join(dir, 'agent.log'), 'utf8');
      const record = JSON.parse(agentLog.trim().split('\n')[0]);
      assert.equal(record.gh, '');
      assert.equal(record.github, '');
      assert.equal(record.args.includes(cursorKey), false);
      assert.equal(record.args.includes('--pool'), false);
      assert.equal(record.args.includes('--api-key'), false);

      const kept = await fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
        body: JSON.stringify({
          cursorApiKey: '',
          owners: [{ owner: 'SolZeroAI', token: '' }],
          repos: 'SolZeroAI/janus',
        }),
      });
      assert.equal(kept.status, 200);
      assert.equal((await readFile(file, 'utf8')).includes(cursorKey), true);
      assert.equal((await disk(dir)).includes(leaked), false);
    });
  } finally {
    await new Promise((resolve) => github.close(resolve));
  }
});
