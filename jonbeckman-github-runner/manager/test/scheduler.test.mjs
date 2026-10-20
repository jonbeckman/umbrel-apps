import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeGitHub } from './fake-github.mjs';
import { createFakeDocker } from './fake-docker.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const pat = (ch) => `github_pat_${ch.repeat(30)}`;

async function listenPort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('manager saves one token per owner, refuses public repos and fork jobs, and starts one private job', async () => {
  const gh = await createFakeGitHub();
  const docker = await createFakeDocker();
  const dir = await mkdtemp(path.join(tmpdir(), 'ghr-'));
  const port = await listenPort();
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      MANUAL_TICK_ONLY: '1',
      GITHUB_API_URL: gh.url,
      DOCKER_SOCK: docker.socketPath,
      STATE_DIR: path.join(dir, 'state'),
      WORK_DIR: path.join(dir, 'work'),
      CACHE_DIR: path.join(dir, 'cache'),
      EXTERNALS_DIR: '',
      RUNNER_IMAGE: 'example/runner:test',
      APP_PROXY_HOST: '',
      RUNNER_UID: String(process.getuid()),
      RUNNER_GID: String(process.getgid()),
      POLL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => logs.push(c.toString()));
  child.stderr.on('data', (c) => logs.push(c.toString()));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, urlPath, body) => {
    const res = await fetch(base + urlPath, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
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

    const classic = await api('POST', '/api/owners', { owner: 'SolZeroAI', token: `ghp_${'a'.repeat(36)}` });
    assert.equal(classic.status, 400, classic.data.error);
    assert.match(classic.data.error, /Classic/);

    const org = await api('POST', '/api/owners', { owner: 'SolZeroAI', token: pat('A') });
    assert.equal(org.status, 200, org.data.error);
    const user = await api('POST', '/api/owners', { owner: 'jonbeckman', token: pat('B') });
    assert.equal(user.status, 200, user.data.error);

    gh.repoOf('SolZeroAI', 'janus').private = false;
    const pub = await api('POST', '/api/repos', { repo: 'https://github.com/SolZeroAI/janus' });
    assert.equal(pub.status, 400, pub.data.error);
    assert.match(pub.data.error, /public/i);
    gh.repoOf('SolZeroAI', 'janus').private = true;
    const added = await api('POST', '/api/repos', { repo: 'SolZeroAI/janus' });
    assert.equal(added.status, 200, added.data.error);

    gh.runs.push({
      id: 1,
      status: 'queued',
      head_repository: { id: 9, fork: true, full_name: 'stranger/janus' },
      repository: { id: 1, full_name: 'SolZeroAI/janus' },
      jobs: [{ id: 11, status: 'queued', name: 'fork', labels: ['self-hosted', 'umbrel'] }],
    });
    const forkTick = await api('POST', '/api/tick', {});
    assert.equal(forkTick.status, 200, forkTick.data.error);
    assert.equal(docker.containers.size, 0);
    const afterFork = await api('GET', '/api/status');
    assert.equal(afterFork.data.repos[0].forks, 1);

    gh.runs.length = 0;
    gh.runs.push({
      id: 2,
      status: 'queued',
      head_repository: { id: 1, fork: false, full_name: 'SolZeroAI/janus' },
      repository: { id: 1, full_name: 'SolZeroAI/janus' },
      jobs: [{ id: 12, status: 'queued', name: 'test', labels: ['self-hosted', 'umbrel'], created_at: '2026-10-20T00:00:00Z' }],
    });
    const tick = await api('POST', '/api/tick', {});
    assert.equal(tick.status, 200, `${tick.data.error}\n${logs.join('')}`);
    assert.equal(docker.containers.size, 1, logs.join(''));
    const spec = [...docker.containers.values()][0].body;
    assert.deepEqual(spec.Entrypoint, ['/usr/local/bin/jonbeckman-runner-entrypoint']);
    assert.deepEqual(spec.Cmd, []);
    assert.deepEqual(spec.Labels['ghr.repo'], 'SolZeroAI/janus');
    assert.ok(spec.Env.some((e) => e.startsWith('npm_config_store_dir=/') && e.includes('SolZeroAI__janus/nub-store')));
    assert.ok(spec.Env.some((e) => e.includes('SolZeroAI__janus/nub-cache')));
    assert.ok(spec.Env.some((e) => e.includes('SolZeroAI__janus/ms-playwright')));
    assert.ok(spec.Env.some((e) => e.includes('SolZeroAI__janus/e2e')));
    assert.equal(spec.Env.some((e) => e.includes('github_pat_')), false);
    assert.ok(spec.Env.some((e) => e.startsWith('ACTIONS_RUNNER_INPUT_JITCONFIG=')));
    assert.equal(spec.HostConfig.Memory, 2 * 1024 ** 3);
    assert.equal(spec.HostConfig.MemorySwap, spec.HostConfig.Memory);
    assert.equal(gh.jitCalls.at(-1).authorization, `Bearer ${pat('A')}`);
    assert.equal(gh.jitCalls.some((c) => c.authorization.includes(pat('B'))), false);

    const metrics = await fetch(`${base}/metrics`);
    const text = await metrics.text();
    assert.equal(metrics.status, 200);
    assert.match(text, /ghr_jobs_queued\{pool="light",repo="SolZeroAI\/janus"\}/);
    assert.equal(text.includes('github_pat_'), false);
    assert.equal(text.includes(pat('A')), false);
  } finally {
    child.kill('SIGKILL');
    await gh.close();
    await docker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
