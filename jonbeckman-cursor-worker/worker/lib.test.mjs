import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REPOS,
  MAX_WORKER_DIRS,
  WORKER_NAME,
  allowRequest,
  authFailure,
  backoffMs,
  bridgeGatewayIps,
  fillGitCredential,
  githubRemote,
  metricValue,
  parseRepoList,
  queryHasSecret,
  redact,
  toPublic,
  tokenKind,
  workerArgs,
  workspaceDir,
} from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pat = (char) => `github_pat_${char.repeat(22)}`;

test('default repositories are the requested set and omit gtt-app', () => {
  assert.deepEqual(DEFAULT_REPOS, [
    'SolZeroAI/janus',
    'SolZeroAI/alchemy.new',
    'SolZeroAI/platform',
    'SolZeroAI/mahoraga-giia',
    'SolZeroAI/grokcast',
    'jonbeckman/grok-bot',
    'jonbeckman/spray',
    'jonbeckman/umbrel-apps',
  ]);
  assert.equal(DEFAULT_REPOS.some((repo) => repo.toLowerCase().includes('gtt-app')), false);
  assert.equal(DEFAULT_REPOS.length <= MAX_WORKER_DIRS, true);
});

test('repo list parsing keeps order and rejects a 21st directory', () => {
  const parsed = parseRepoList('git@github.com:SolZeroAI/janus.git\nhttps://github.com/jonbeckman/spray\n# skip\n');
  assert.deepEqual(parsed, { repos: ['SolZeroAI/janus', 'jonbeckman/spray'], errors: [] });
  const tooMany = parseRepoList(Array.from({ length: 21 }, (_, i) => `jonbeckman/repo-${i}`));
  assert.equal(tooMany.errors.length, 1);
  assert.equal(parseRepoList('not a repo').errors.length, 1);
  assert.equal(parseRepoList('../x/y').repos.length, 0);
});

test('workspace paths are per repo name and stay inside the root', () => {
  const repos = ['SolZeroAI/janus', 'SolZeroAI/alchemy.new', 'acme/janus'];
  assert.equal(workspaceDir('/workspaces', 'SolZeroAI/alchemy.new', repos), '/workspaces/alchemy.new');
  assert.equal(workspaceDir('/workspaces', 'SolZeroAI/janus', repos), '/workspaces/SolZeroAI__janus');
  assert.equal(workspaceDir('/workspaces/', 'acme/janus', repos), '/workspaces/acme__janus');
  assert.equal(githubRemote('SolZeroAI/janus'), 'https://github.com/SolZeroAI/janus.git');
  assert.equal(githubRemote('https://github.com/SolZeroAI/janus.git').includes('@'), false);
});

test('worker argv is My Machines, named umbrel, with options before start', () => {
  const args = workerArgs({
    dirs: ['/workspaces/janus', '/workspaces/spray'],
    managementAddr: '127.0.0.1:4646',
  });
  assert.deepEqual(args, [
    'worker',
    '--name', WORKER_NAME,
    '--idle-release-timeout', '0',
    '--management-addr', '127.0.0.1:4646',
    '--worker-dir', '/workspaces/janus',
    '--worker-dir', '/workspaces/spray',
    'start',
    '--verbose',
  ]);
  assert.equal(args.includes('--pool'), false);
  assert.equal(args.includes('--api-key'), false);
  assert.equal(args.includes('--single-use'), false);
  assert.equal(args.includes('--connect-workspace'), false);
  assert.equal(args.indexOf('start') > args.indexOf('--worker-dir'), true);
  assert.equal(args.at(-1), '--verbose');
});

test('connected comes from the metrics gauge, not a busy readyz', () => {
  const text = [
    '# TYPE cursor_self_hosted_worker_connected gauge',
    'cursor_self_hosted_worker_connected 1',
    'cursor_self_hosted_worker_session_active 0',
  ].join('\n');
  assert.equal(metricValue(text, 'cursor_self_hosted_worker_connected'), 1);
  assert.equal(metricValue('cursor_self_hosted_worker_connected{worker="umbrel"} 0\n', 'cursor_self_hosted_worker_connected'), 0);
  assert.equal(metricValue('cursor_self_hosted_worker_session_active 1\n', 'cursor_self_hosted_worker_connected'), null);
});

test('redaction removes saved secrets, token shapes, and userinfo urls', () => {
  const key = 'cursor_test_key_9f3a7c1e';
  const token = pat('d');
  const input = `error ${key} ${token} https://x-access-token:${token}@github.com/SolZeroAI/janus.git?token=${token}`;
  const out = redact(input, [key, token]);
  assert.equal(out.includes(key), false);
  assert.equal(out.includes(token), false);
  assert.equal(out.includes('x-access-token'), false);
  assert.match(out, /https:\/\/github\.com/);
  assert.equal(authFailure('fatal: Authentication failed for https://github.com/acme/app.git'), true);
  assert.equal(authFailure('Could not resolve host: github.com'), false);
});

test('status view is masked', () => {
  const key = 'cursor_test_key_9f3a7c1e';
  const token = pat('e');
  const body = toPublic({
    cursorApiKey: key,
    owners: { SolZeroAI: { token }, jonbeckman: { token: '' } },
    repos: ['SolZeroAI/janus'],
  }, {
    running: true,
    connected: false,
    lastError: '',
    skipped: [],
    dirs: ['/workspaces/janus'],
  });
  const text = JSON.stringify(body);
  assert.equal(text.includes(key), false);
  assert.equal(text.includes(token), false);
  assert.equal(body.cursorKey, 'key saved');
  assert.equal(body.owners.find((row) => row.owner === 'SolZeroAI').token, 'token saved');
  assert.equal(body.owners.find((row) => row.owner === 'jonbeckman').token, 'not set');
  assert.equal(body.worker.name, 'umbrel');
  assert.equal(body.worker.running, true);
});

test('git credential helper answers github.com and nothing else', () => {
  const token = pat('f');
  const state = { owners: { SolZeroAI: { token } } };
  const got = fillGitCredential('protocol=https\nhost=github.com\npath=SolZeroAI/janus.git\n', state);
  assert.equal(got, `username=x-access-token\npassword=${token}\n`);
  assert.equal(fillGitCredential('protocol=https\nhost=gitlab.com\npath=SolZeroAI/janus.git\n', state), '');
  assert.equal(fillGitCredential('protocol=https\nhost=github.com\npath=jonbeckman/spray.git\n', state), '');
});

test('credential helper process does not write the token to stderr', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cursor-cred-'));
  const token = pat('g');
  const file = path.join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ owners: { SolZeroAI: { token } } }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./credential.mjs', import.meta.url))], {
    env: { ...process.env, CURSOR_WORKER_STATE: file },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end('protocol=https\nhost=github.com\npath=SolZeroAI/janus.git\n');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  await rm(dir, { recursive: true, force: true });
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`password=${token}\\n`));
  assert.equal(stderr.includes(token), false);
  assert.equal(stderr, '');
});

test('backoff grows and then caps', () => {
  assert.equal(backoffMs(0, 40), 0);
  assert.equal(backoffMs(1, 40), 40);
  assert.equal(backoffMs(3, 40), 160);
  assert.equal(backoffMs(20, 40), 600_000);
});

test('token kinds and request allow list', () => {
  assert.equal(tokenKind(pat('h')), 'fine-grained');
  assert.equal(tokenKind(`ghp_${'h'.repeat(20)}`), 'classic');
  assert.equal(tokenKind('cursor_user_key'), 'unknown');
  const gateways = bridgeGatewayIps('Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00000000 010011AC 0003 0 0 0 00000000 0 0 0\n');
  assert.equal(gateways.has('172.17.0.1'), true);
  assert.equal(allowRequest('127.0.0.1', { gateways, proxyIps: new Set() }), true);
  assert.equal(allowRequest('172.17.0.9', { gateways, proxyIps: new Set() }), false);
  assert.equal(allowRequest('10.0.0.8', { gateways, proxyIps: new Set(['10.0.0.8']) }), true);
  assert.equal(queryHasSecret(`/api/save?token=${pat('h')}`), true);
  assert.equal(queryHasSecret('/healthz?ready=1'), false);
});

test('packaging is unprivileged, digest-pinned, and behind the Umbrel login', async () => {
  const dir = path.join(root, 'jonbeckman-cursor-worker');
  const manifest = await readFile(path.join(dir, 'umbrel-app.yml'), 'utf8');
  const compose = await readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
  const docker = await readFile(path.join(dir, 'worker/Dockerfile'), 'utf8');
  const hook = await readFile(path.join(dir, 'hooks/pre-start'), 'utf8');
  assert.match(manifest, /^id:\s*jonbeckman-cursor-worker/m);
  assert.match(manifest, /^version:\s*"0\.1\.0"/m);
  assert.match(manifest, /^port:\s*3502/m);
  assert.equal(/^\s*ports:/m.test(compose), false);
  assert.equal(/privileged\s*:/m.test(compose), false);
  assert.equal(compose.includes('docker.sock'), false);
  assert.match(compose, /mem_limit:\s*2048m/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /user:\s*"1001:1001"/);
  assert.match(compose, /PROXY_AUTH_ADD:\s*"true"/);
  assert.match(compose, /APP_HOST: jonbeckman-cursor-worker_worker_1/);
  assert.match(compose, /\$\{APP_DATA_DIR\}\/data\/cursor-home:\/home\/cursor\/\.cursor/);
  assert.match(compose, /\$\{APP_DATA_DIR\}\/data\/cursor-config:\/home\/cursor\/\.config\/cursor/);
  assert.match(compose, /\$\{APP_DATA_DIR\}\/data\/workspaces:\/workspaces/);
  assert.match(compose, /\$\{APP_DATA_DIR\}\/data\/state:\/state/);
  assert.match(compose, /pinned-by-ci/);
  assert.match(docker, /ubuntu:24\.04@sha256:[a-f0-9]{64}/);
  assert.match(docker, /curl https:\/\/cursor\.com\/install -fsS \| bash/);
  assert.match(docker, /USER cursor/);
  assert.equal(docker.includes('docker.sock'), false);
  assert.equal(docker.includes('--pool'), false);
  assert.match(hook, /1001/);
  assert.match(hook, /data\/state/);
  const runner = await readFile(path.join(root, 'jonbeckman-github-runner/umbrel-app.yml'), 'utf8');
  const alloy = await readFile(path.join(root, 'jonbeckman-grafana-alloy/umbrel-app.yml'), 'utf8');
  const ports = [runner, alloy, manifest].map((text) => text.match(/^port:\s*(\d+)/m)[1]);
  assert.equal(new Set(ports).size, ports.length);
});
