import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function start(extra, state) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cursor-worker-'));
  const port = await listenPort();
  const metrics = await listenPort();
  const stateDir = path.join(dir, 'state');
  await mkdir(stateDir, { recursive: true });
  const cursorKey = extra.cursorKey || 'cursor_test_key_9f3a7c1e';
  const token = extra.token || pat('r');
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state || {
    cursorApiKey: cursorKey,
    owners: { SolZeroAI: { token } },
    repos: ['SolZeroAI/janus'],
  }), { mode: 0o600 });
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      MANAGEMENT_ADDR: `127.0.0.1:${metrics}`,
      STATE_DIR: stateDir,
      CURSOR_WORKER_STATE: path.join(stateDir, 'state.json'),
      WORKSPACES_DIR: path.join(dir, 'workspaces'),
      HOME: path.join(dir, 'home'),
      AGENT_NODE_SCRIPT: FAKE_AGENT,
      GIT_NODE_SCRIPT: FAKE_GIT,
      FAKE_AGENT_LOG: path.join(dir, 'agent.log'),
      FAKE_GIT_LOG: path.join(dir, 'git.log'),
      APP_PROXY_HOST: '',
      WORKER_AUTOSTART: '1',
      WORKER_BACKOFF_BASE_MS: extra.backoff || '50',
      METRICS_POLL_MS: '30',
      WORKER_STOP_MS: '300',
      FAKE_GIT_FAIL: extra.fail || '',
      FAKE_AGENT_EXIT: extra.exit || '',
      FAKE_AGENT_CONNECTED: extra.connected || '',
      GH_TOKEN: pat('n'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) { up = true; break; }
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!up) {
    child.kill('SIGKILL');
    throw new Error(logs.join(''));
  }
  return {
    base,
    dir,
    logs,
    cursorKey,
    token,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 150));
      child.kill('SIGKILL');
      const agentLog = await readFile(path.join(dir, 'agent.log'), 'utf8').catch(() => '');
      for (const line of agentLog.split('\n')) {
        if (!line) continue;
        try { process.kill(JSON.parse(line).pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      await rm(dir, { recursive: true, force: true });
    },
    async agentRecords() {
      const text = await readFile(path.join(dir, 'agent.log'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    async gitArgs() {
      const text = await readFile(path.join(dir, 'git.log'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return last;
}

test('an unreachable repository is skipped and the worker still starts', async () => {
  const token = pat('r');
  const cursorKey = 'cursor_test_key_9f3a7c1e';
  const app = await start({
    fail: 'jonbeckman/spray',
    token,
    cursorKey,
  }, {
    cursorApiKey: cursorKey,
    owners: { SolZeroAI: { token }, jonbeckman: { token } },
    repos: ['SolZeroAI/janus', 'jonbeckman/spray'],
  });
  try {
    const running = await waitFor(async () => {
      const status = await (await fetch(`${app.base}/api/status`)).json();
      const records = await app.agentRecords();
      return status.worker.running && records.length ? { status, records } : null;
    });
    assert.ok(running, app.logs.join(''));
    const args = running.records.at(-1).args;
    assert.equal(args.includes('--pool'), false);
    assert.equal(args.includes('--api-key'), false);
    assert.equal(running.records.at(-1).gh, '');
    assert.ok(args.some((arg) => arg.endsWith('/janus')));
    assert.equal(args.some((arg) => arg.endsWith('/spray')), false);
    assert.equal(args.indexOf('start') > args.lastIndexOf('--worker-dir'), true);
    assert.equal(running.status.worker.skipped.some((row) => row.repo === 'jonbeckman/spray'), true);
    const body = JSON.stringify(running.status);
    const text = app.logs.join('');
    assert.equal(body.includes(token), false);
    assert.equal(body.includes(cursorKey), false);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(cursorKey), false);
    const git = (await app.gitArgs()).flat();
    assert.equal(git.some((arg) => String(arg).includes(`${token}@`)), false);
    assert.ok(git.some((arg) => arg === 'https://github.com/SolZeroAI/janus.git'));
    assert.ok(git.some((arg) => arg === 'https://github.com/jonbeckman/spray.git'));
  } finally {
    await app.stop();
  }
});

test('a worker that exits is restarted with backoff, not a tight loop', async () => {
  const app = await start({ exit: '7', backoff: '60' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 420));
    const records = await app.agentRecords();
    assert.ok(records.length >= 2, `starts=${records.length} ${app.logs.join('')}`);
    assert.ok(records.length <= 6, `starts=${records.length}`);
    assert.ok(records[1].at - records[0].at >= 50);
    const health = await fetch(`${app.base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(app.logs.join('').includes(app.cursorKey), false);
  } finally {
    await app.stop();
  }
});

test('when every repository is unreachable the process stays up and does not spawn', async () => {
  const app = await start({ fail: 'SolZeroAI/janus', backoff: '60' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 420));
    const records = await app.agentRecords();
    assert.equal(records.length, 0, app.logs.join(''));
    const git = await app.gitArgs();
    const clones = git.filter((args) => args.includes('clone'));
    assert.ok(clones.length >= 2, `clones=${clones.length}`);
    assert.ok(clones.length <= 6, `clones=${clones.length}`);
    const status = await (await fetch(`${app.base}/api/status`)).json();
    assert.equal(status.worker.running, false);
    assert.equal(status.worker.connected, false);
    assert.equal(JSON.stringify(status).includes(app.token), false);
    assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
    assert.equal(app.logs.join('').includes(app.token), false);
  } finally {
    await app.stop();
  }
});

test('save and restart replaces the worker process', async () => {
  const app = await start({});
  try {
    const first = await waitFor(async () => {
      const records = await app.agentRecords();
      const status = await (await fetch(`${app.base}/api/status`)).json();
      return records.length && status.worker.connected ? records[0] : null;
    });
    assert.ok(first, app.logs.join(''));
    const saved = await fetch(`${app.base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
      body: JSON.stringify({
        cursorApiKey: '',
        owners: [{ owner: 'SolZeroAI', token: '' }],
        repos: 'SolZeroAI/janus',
      }),
    });
    const savedText = await saved.text();
    assert.equal(saved.status, 200, savedText);
    assert.equal(savedText.includes(app.cursorKey), false);
    assert.equal(savedText.includes(app.token), false);
    const second = await waitFor(async () => {
      const records = await app.agentRecords();
      return records.length >= 2 ? records : null;
    });
    assert.ok(second, app.logs.join(''));
    assert.notEqual(second[1].pid, first.pid);
    assert.throws(() => process.kill(first.pid, 0));
    assert.equal(JSON.stringify(second[1].args).includes(app.cursorKey), false);
    const body = await (await fetch(`${app.base}/api/status`)).text();
    assert.equal(body.includes(app.cursorKey), false);
    assert.equal(body.includes(app.token), false);
    assert.equal(app.logs.join('').includes(app.cursorKey), false);
  } finally {
    await app.stop();
  }
});
