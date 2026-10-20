import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const secrets = {
  promUrl: 'https://prometheus-prod-00.grafana.net/api/prom/push',
  promUser: '123',
  lokiUrl: 'https://logs-prod-00.grafana.net/loki/api/v1/push',
  lokiUser: '456',
  otlpUrl: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp',
  otlpUser: '789',
  token: 'glc_exampletoken',
};

function listenPort() {
  return import('node:net').then((net) => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
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
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => {
    const hasSrc = /\bsrc\s*=\s*["'][^"']+["']/.test(m[1]);
    return !hasSrc || m[2].trim().length > 0;
  });
}

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alloy-page-'));
  const port = await listenPort();
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      ALLOY_DIR: dir,
      DOCKER_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => logs.push(c.toString()));
  child.stderr.on('data', (c) => logs.push(c.toString()));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`${base}/healthz`);
        if (res.ok) { up = true; break; }
      } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(up, true, logs.join(''));
    await fn({ base, logs, dir });
  } finally {
    child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
}

async function disk(dir) {
  const names = await readdir(dir);
  const parts = [];
  for (const name of names) parts.push(await readFile(path.join(dir, name), 'utf8').catch(() => ''));
  return parts.join('\n');
}

test('served setup page has no inline script and the CSP allows its script', async () => {
  const docker = await readFile(fileURLToPath(new URL('./Dockerfile', import.meta.url)), 'utf8');
  assert.match(docker, /page\.js/);
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    const csp = res.headers.get('content-security-policy');
    assert.equal(res.status, 200);
    assert.equal(inlineScripts(html).length, 0);
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(html), false);
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    assert.deepEqual(srcs, ['/page.js']);
    const policy = scriptPolicy(csp);
    assert.ok(policy.includes("'self'"));
    assert.equal(policy.includes("'unsafe-inline'"), false);
    assert.equal(policy.includes("'unsafe-eval'"), false);
    for (const src of srcs) assert.match(src, /^\/(?!\/)/);
    const form = html.match(/<form\b[^>]*>/i)[0];
    assert.match(form, /\bmethod\s*=\s*["']post["']/i);
    assert.match(form, /\baction\s*=\s*["']\/api\/secrets["']/i);
    assert.equal(/\bmethod\s*=\s*["']get["']/i.test(form), false);

    const js = await fetch(`${base}/page.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const code = await js.text();
    assert.match(code, /Not configured yet/);
    assert.match(code, /preventDefault/);
    assert.match(code, /\/api\/secrets/);
    assert.match(code, /application\/json/);
    const jsPolicy = scriptPolicy(js.headers.get('content-security-policy'));
    assert.equal(jsPolicy.includes("'unsafe-inline'"), false);
  });
});

test('a GET with a token query is not stored and is not logged', async () => {
  const leaked = `glc_${'q'.repeat(16)}`;
  await withServer(async ({ base, logs, dir }) => {
    const qs = new URLSearchParams({ ...secrets, token: leaked });
    const got = await fetch(`${base}/?${qs}`);
    const body = await got.text();
    assert.equal(got.status, 400);
    assert.equal(body.includes(leaked), false);
    assert.match(body, /query string/);
    assert.equal((await disk(dir)).includes(leaked), false);
    const text = logs.join('');
    assert.equal(text.includes(leaked), false);
    assert.equal(/token=/i.test(text), false);

    const status = await fetch(`${base}/api/status?token=${encodeURIComponent(leaked)}`);
    assert.equal(status.status, 400);
    assert.equal((await status.text()).includes(leaked), false);
    assert.equal((await disk(dir)).includes(leaked), false);

    const saved = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
      body: JSON.stringify(secrets),
    });
    const savedBody = await saved.text();
    assert.equal(saved.status, 200, savedBody);
    assert.equal(savedBody.includes(secrets.token), false);
    const after = await (await fetch(`${base}/api/status`)).json();
    assert.equal(after.configured, true);
    assert.equal(after.tokenSet, true);
    assert.equal(JSON.stringify(after).includes(secrets.token), false);

    const again = await fetch(`${base}/api/secrets?token=${encodeURIComponent(leaked)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
      body: JSON.stringify(secrets),
    });
    assert.equal(again.status, 400);
    assert.equal((await disk(dir)).includes(leaked), false);
    assert.equal(logs.join('').includes(leaked), false);
    assert.equal(logs.join('').includes(secrets.token), false);

    const form = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-GHR-Request': '1' },
      body: `token=${encodeURIComponent(leaked)}&promUrl=https://prometheus.example/api/prom/push`,
    });
    const formBody = await form.text();
    assert.equal(form.status, 400);
    assert.equal(formBody.includes(leaked), false);
    assert.match(formBody, /Expected JSON/);
    assert.equal((await disk(dir)).includes(leaked), false);

    const bare = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(leaked)}`,
    });
    assert.equal(bare.status, 403);
    assert.equal((await bare.text()).includes(leaked), false);
    assert.equal((await disk(dir)).includes(leaked), false);
    assert.equal(/token=/i.test(logs.join('')), false);
  });
});
