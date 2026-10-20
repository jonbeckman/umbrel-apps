import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

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
  const dir = await mkdtemp(path.join(tmpdir(), 'ghr-page-'));
  const port = await listenPort();
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      MANUAL_TICK_ONLY: '1',
      STATE_DIR: path.join(dir, 'state'),
      WORK_DIR: path.join(dir, 'work'),
      CACHE_DIR: '',
      EXTERNALS_DIR: '',
      RUNNER_IMAGE: 'example/runner:test',
      APP_PROXY_HOST: '',
      GITHUB_API_URL: 'http://127.0.0.1:9',
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
  const out = [];
  async function walk(current) {
    const names = await readdir(current, { withFileTypes: true });
    for (const name of names) {
      const full = path.join(current, name.name);
      if (name.isDirectory()) await walk(full);
      else out.push(await readFile(full, 'utf8').catch(() => ''));
    }
  }
  await walk(dir);
  return out.join('\n');
}

test('served manager page has no inline script and the CSP allows its script', async () => {
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
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    assert.match(form, /\bmethod\s*=\s*["']post["']/i);
    assert.match(form, /\baction\s*=\s*["']\/api\/owners["']/i);
    assert.match(form, /name="token"/);
    assert.match(form, /type="password"/);
    assert.equal(/\bmethod\s*=\s*["']get["']/i.test(form), false);

    const js = await fetch(`${base}/page.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const code = await js.text();
    assert.match(code, /preventDefault/);
    assert.match(code, /\/api\/status/);
    assert.match(code, /\/api\/owners/);
    assert.equal(scriptPolicy(js.headers.get('content-security-policy')).includes("'unsafe-inline'"), false);
  });
});

test('a GET with a token query is not stored and is not logged', async () => {
  const leaked = `github_pat_${'q'.repeat(22)}`;
  await withServer(async ({ base, logs, dir }) => {
    const got = await fetch(`${base}/api/owners?owner=SolZeroAI&token=${encodeURIComponent(leaked)}`);
    const body = await got.text();
    assert.equal(got.status, 400);
    assert.equal(body.includes(leaked), false);
    assert.match(body, /query string/);
    assert.equal((await disk(dir)).includes(leaked), false);
    assert.equal(logs.join('').includes(leaked), false);
    assert.equal(/token=/i.test(logs.join('')), false);

    const page = await fetch(`${base}/?token=${encodeURIComponent(leaked)}`);
    assert.equal(page.status, 400);
    assert.equal((await page.text()).includes(leaked), false);

    const form = await fetch(`${base}/api/owners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-GHR-Request': '1' },
      body: `owner=SolZeroAI&token=${encodeURIComponent(leaked)}`,
    });
    const formBody = await form.text();
    assert.equal(form.status, 400);
    assert.equal(formBody.includes(leaked), false);
    assert.match(formBody, /Expected JSON/);
    assert.equal((await disk(dir)).includes(leaked), false);

    const bare = await fetch(`${base}/api/owners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `owner=SolZeroAI&token=${encodeURIComponent(leaked)}`,
    });
    assert.equal(bare.status, 403);
    assert.equal((await bare.text()).includes(leaked), false);
    assert.equal((await disk(dir)).includes(leaked), false);
    assert.equal(logs.join('').includes(leaked), false);
    assert.equal(/token=/i.test(logs.join('')), false);

    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200);
    const data = await status.json();
    assert.equal(JSON.stringify(data).includes(leaked), false);
    assert.equal(data.owners.length, 0);
  });
});
