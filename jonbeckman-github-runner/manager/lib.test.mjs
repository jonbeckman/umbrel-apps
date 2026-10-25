import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allowRequest,
  backoffMs,
  bridgeGatewayIps,
  cacheEnv,
  classifyQueued,
  cpuCores,
  demuxDockerLogs,
  forkHead,
  jobLimits,
  jobWantsUs,
  memUsed,
  normalizeRepo,
  ownerOf,
  ownsRunner,
  parseRunnerLog,
  collectProxyIps,
  planSpawns,
  proxyLookupHosts,
  proxyLookupNotice,
  pruneHistory,
  reapReason,
  redact,
  renderMetrics,
  repoCacheLayout,
  runnerLabels,
  tokenHint,
  tokenKind,
} from './lib.mjs';

const GiB = 1024 ** 3;

test('normalizeRepo accepts the usual spellings and rejects the rest', () => {
  for (const s of [
    'SolZeroAI/janus',
    ' SolZeroAI/janus ',
    'https://github.com/SolZeroAI/janus',
    'https://github.com/SolZeroAI/janus.git',
    'https://www.github.com/SolZeroAI/janus/',
    'git@github.com:SolZeroAI/janus.git',
  ]) {
    assert.equal(normalizeRepo(s), 'SolZeroAI/janus', s);
  }
  assert.equal(normalizeRepo('jonbeckman/umbrel-apps'), 'jonbeckman/umbrel-apps');
  for (const s of ['', 'jonbeckman', 'a/b/c', 'SolZeroAI/..', '-x/y', 'x-/y', 'a--b/c', 'https://gitlab.com/a/b', null]) {
    assert.equal(normalizeRepo(s), null, String(s));
  }
  assert.equal(ownerOf('SolZeroAI/janus'), 'SolZeroAI');
});

test('runner labels keep umbrel and umbrel-docker apart', () => {
  assert.deepEqual(runnerLabels('x64'), ['self-hosted', 'umbrel', 'Linux', 'X64']);
  assert.deepEqual(runnerLabels('arm64', { docker: true }), ['self-hosted', 'umbrel-docker', 'Linux', 'ARM64']);
  const light = runnerLabels('x64');
  const docker = runnerLabels('x64', { docker: true });
  assert.equal(jobWantsUs(['self-hosted', 'umbrel'], light), true);
  assert.equal(jobWantsUs(['self-hosted'], light), false);
  assert.equal(jobWantsUs(['self-hosted', 'umbrel', 'gpu'], light), false);
  assert.equal(jobWantsUs(['self-hosted', 'umbrel-docker'], light), false);
  assert.equal(jobWantsUs(['self-hosted', 'umbrel-docker'], docker), true);
  assert.equal(jobWantsUs(['self-hosted', 'umbrel'], docker), false);
  assert.equal(classifyQueued(['self-hosted', 'umbrel-docker'], { light, docker, dockerOn: false }), 'docker-off');
  assert.equal(classifyQueued(['self-hosted', 'umbrel-docker'], { light, docker, dockerOn: true }), 'docker');
  assert.equal(classifyQueued(['self-hosted', 'umbrel', 'ARM64'], { light, docker, dockerOn: true }), 'mismatch');
  assert.equal(classifyQueued(['ubuntu-latest'], { light, docker, dockerOn: true }), '');
});

test('fork heads are refused, including a missing head repository', () => {
  assert.equal(forkHead({ head_repository: { fork: false, id: 1 }, repository: { id: 1, full_name: 'SolZeroAI/janus' } }), '');
  assert.match(forkHead({ head_repository: { fork: true, full_name: 'stranger/janus' } }), /fork/);
  assert.match(forkHead({ head_repository: null }), /no head repository/);
  assert.match(forkHead({ head_repository: { fork: false, id: 9, full_name: 'other/janus' }, repository: { id: 1, full_name: 'SolZeroAI/janus' } }), /not SolZeroAI/);
});

test('jobLimits splits half the memory across the cap', () => {
  assert.deepEqual(jobLimits({ ncpu: 4, memBytes: 8 * GiB, maxRunners: 2 }), { cpus: 4, memory: 2 * GiB, pids: 4096, shm: 512 * 1024 ** 2 });
  assert.equal(jobLimits({ ncpu: 4, memBytes: 8 * GiB, maxRunners: 4 }).memory, GiB);
  assert.equal(jobLimits({ ncpu: 64, memBytes: 256 * GiB, maxRunners: 1 }).memory, 8 * GiB);
  assert.equal(jobLimits({ memBytes: 8 * GiB, maxRunners: 99 }).memory, jobLimits({ memBytes: 8 * GiB, maxRunners: 4 }).memory);
});

test('planSpawns shares slots, prefers the oldest queue, and caps docker', () => {
  const repos = [
    { name: 'a/new', queued: 5, oldestQueuedAt: '2026-10-20T00:05:00Z' },
    { name: 'a/old', queued: 5, oldestQueuedAt: '2026-10-20T00:00:00Z' },
  ];
  assert.deepEqual(planSpawns({ repos, runners: [], maxRunners: 3 }).map((p) => p.repo), ['a/old', 'a/new', 'a/old']);
  assert.deepEqual(planSpawns({ repos: [{ name: 'a/x', queued: 2 }], runners: [{ repo: 'a/x', busy: false, docker: false }], maxRunners: 4 }).map((p) => p.repo), ['a/x']);
  const mixed = [{ name: 'a/x', queued: 1, queuedDocker: 3, oldestQueuedAt: '2026-10-20T00:05:00Z', oldestDockerQueuedAt: '2026-10-20T00:00:00Z' }];
  assert.deepEqual(planSpawns({ repos: mixed, runners: [], maxRunners: 4 }), [
    { repo: 'a/x', docker: true },
    { repo: 'a/x', docker: false },
  ]);
  assert.deepEqual(planSpawns({ repos: mixed, runners: [{ repo: 'a/x', busy: true, docker: true }], maxRunners: 4 }), [{ repo: 'a/x', docker: false }]);
  const now = Date.parse('2026-10-20T00:00:00Z');
  assert.deepEqual(planSpawns({ repos: [{ name: 'a/x', queued: 1, blockedUntil: now + 1000 }], runners: [], maxRunners: 2, now }), []);
});

test('reap, backoff, tokens, and runner names', () => {
  const now = 10_000_000;
  const opts = { now, idleMs: 600_000, maxJobMs: 6 * 3600_000 };
  assert.equal(reapReason({ createdAt: now - 60_000, busy: false }, opts), '');
  assert.equal(reapReason({ createdAt: now - 700_000, busy: false }, opts), 'idle');
  assert.equal(reapReason({ createdAt: now - 7 * 3600_000, busy: true }, opts), 'timeout');
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(6), 600_000);
  assert.equal(tokenKind(`github_pat_${'a'.repeat(22)}`), 'fine-grained');
  assert.equal(tokenKind(`ghp_${'a'.repeat(36)}`), 'classic');
  assert.equal(tokenKind('nope'), 'unknown');
  assert.equal(tokenHint('github_pat_secret1234'), '…1234');
  assert.equal(ownsRunner('ab12', 'umbrel-ab12-0a1b2c'), true);
  assert.equal(ownsRunner('ab12', 'umbrel-cd34-0a1b2c'), false);
  assert.equal(ownsRunner('ab12', 'umbrel-0a1b2c3d'), false);
});

test('per-repo cache paths stay apart and cover nub, browsers, and e2e', () => {
  const a = repoCacheLayout('/ghr-cache', 'SolZeroAI/janus');
  const b = repoCacheLayout('/ghr-cache', 'jonbeckman/notes');
  assert.equal(a.nubStore, '/ghr-cache/SolZeroAI__janus/nub-store');
  assert.equal(a.nubCache, '/ghr-cache/SolZeroAI__janus/nub-cache');
  assert.equal(a.browsers, '/ghr-cache/SolZeroAI__janus/ms-playwright');
  assert.equal(a.e2e, '/ghr-cache/SolZeroAI__janus/e2e');
  assert.notEqual(a.base, b.base);
  const env = cacheEnv(a);
  assert.ok(env.includes('npm_config_store_dir=/ghr-cache/SolZeroAI__janus/nub-store'));
  assert.ok(env.includes('NUB_CACHE_DIR=/ghr-cache/SolZeroAI__janus/nub-cache'));
  assert.ok(env.includes('PLAYWRIGHT_BROWSERS_PATH=/ghr-cache/SolZeroAI__janus/ms-playwright'));
  assert.ok(env.includes('E2E_CACHE_DIR=/ghr-cache/SolZeroAI__janus/e2e'));
});

test('runner log, docker frames, memory, and cpu', () => {
  const text = '√ Connected to GitHub\n2026-10-20 00:00:00Z: Listening for Jobs\n2026-10-20 00:00:05Z: Running job: test\n2026-10-20 00:03:00Z: Job test completed with result: Succeeded\n';
  assert.equal(parseRunnerLog(text).result, 'Succeeded');
  assert.equal(parseRunnerLog(text).jobStartedAt, '2026-10-20T00:00:05Z');
  const frame = (type, s) => {
    const body = Buffer.from(s);
    const h = Buffer.alloc(8);
    h[0] = type;
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  assert.equal(demuxDockerLogs(Buffer.concat([frame(1, 'hi'), frame(2, '!')])), 'hi!');
  assert.equal(memUsed({ usage: 1000, stats: { inactive_file: 400 } }), 600);
  assert.equal(cpuCores({ at: 0, cpuNs: 0 }, { at: 1000, cpuNs: 2e9 }), 2);
});

test('metrics name repo, conclusion, wait, and duration, and hide secrets', () => {
  const text = renderMetrics({
    queued: [{ repo: 'SolZeroAI/janus', pool: 'light', count: 2 }],
    running: [{ repo: 'SolZeroAI/janus', pool: 'light', count: 1 }],
    finished: [{ repo: 'SolZeroAI/janus', conclusion: 'Succeeded', count: 3 }],
    samples: [{ repo: 'SolZeroAI/janus', wait: 4, duration: 40 }],
    runners: [{ repo: 'SolZeroAI/janus', runner: 'umbrel-ab12-0a1b2c', cpu: 0.5, mem: 100 }],
  });
  assert.match(text, /ghr_jobs_queued\{pool="light",repo="SolZeroAI\/janus"\} 2/);
  assert.match(text, /ghr_jobs_finished_total\{conclusion="Succeeded",repo="SolZeroAI\/janus"\} 3/);
  assert.match(text, /ghr_job_queue_wait_seconds_bucket\{le="5",repo="SolZeroAI\/janus"\} 1/);
  assert.match(text, /ghr_job_duration_seconds_sum\{repo="SolZeroAI\/janus"\} 40/);
  assert.match(text, /ghr_runner_memory_bytes/);
  assert.equal(text.includes('github_pat_'), false);
  assert.equal(redact('token github_pat_abc and ghp_zzzz'), 'token github_pat_[redacted] and gh*_ [redacted]');
  assert.equal(redact('GET /api/owners?token=github_pat_abc&x=1'), 'GET /api/owners');
  assert.equal(redact('GET /healthz?ready=1'), 'GET /healthz?ready=1');
  assert.equal(redact('saved glc_exampletokenvalue'), 'saved glc_[redacted]');
});

test('request allow-list keeps the API off sibling apps and opens metrics', () => {
  const gateways = bridgeGatewayIps('Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010011AC\t0003\n');
  assert.ok(gateways.has('172.17.0.1'));
  const proxyIps = new Set(['172.17.0.4']);
  assert.equal(allowRequest('/api/status', '172.17.0.4', { gateways, proxyIps }), true);
  assert.equal(allowRequest('/api/status', '172.17.0.9', { gateways, proxyIps }), false);
  assert.equal(allowRequest('/metrics', '172.17.0.9', { gateways, proxyIps }), true);
  assert.equal(allowRequest('/healthz', '127.0.0.1', { gateways, proxyIps }), true);
  // umbrelOS 2 has no app_proxy container. The host gateway is the proxy.
  assert.equal(allowRequest('/', '172.17.0.1', { gateways, proxyIps: new Set() }), true);
  assert.equal(allowRequest('/api/status', '::ffff:172.17.0.1', { gateways, proxyIps: new Set() }), true);
  assert.equal(allowRequest('/api/status', '172.17.0.9', { gateways, proxyIps: new Set() }), false);
});

test('proxy lookup tries the sidecar names and logs a miss once', () => {
  assert.deepEqual(proxyLookupHosts(''), []);
  assert.deepEqual(proxyLookupHosts('jonbeckman-github-runner_app_proxy_1'), [
    'jonbeckman-github-runner_app_proxy_1',
    'app_proxy',
    'jonbeckman-github-runner-app_proxy-1',
    'jonbeckman-github-runner-app-proxy-1',
  ]);
  const miss = [
    { host: 'jonbeckman-github-runner_app_proxy_1', error: 'ENOTFOUND' },
    { host: 'app_proxy', error: 'ENOTFOUND' },
    { host: 'jonbeckman-github-runner-app_proxy-1', error: 'ENODATA' },
    { host: 'jonbeckman-github-runner-app-proxy-1', error: 'ENOTFOUND' },
  ];
  const first = proxyLookupNotice('', miss);
  assert.deepEqual(first.ips, []);
  assert.equal(first.keepPrevious, false);
  assert.equal(first.log.level, 'info');
  assert.equal(first.log.msg, 'app proxy container is not on this network');
  assert.equal(first.log.fields.hosts.includes('app_proxy'), true);
  const again = proxyLookupNotice(first.signature, miss);
  assert.equal(again.log, null);
  assert.equal(again.signature, first.signature);

  const shared = proxyLookupNotice('', [
    { host: 'app_proxy', ips: ['10.0.0.2', '10.0.0.3'] },
    { host: 'jonbeckman-github-runner_app_proxy_1', error: 'ENOTFOUND' },
  ]);
  assert.deepEqual(shared.ips, []);
  const unique = collectProxyIps([
    { host: 'app_proxy', ips: ['10.0.0.8'] },
    { host: 'jonbeckman-github-runner_app_proxy_1', ips: ['10.0.0.8', '10.0.0.9'] },
  ]);
  assert.deepEqual(unique, ['10.0.0.8', '10.0.0.9']);

  const down = proxyLookupNotice('', [
    { host: 'app_proxy', error: 'ESERVFAIL' },
    { host: 'jonbeckman-github-runner_app_proxy_1', error: 'ENOTFOUND' },
  ]);
  assert.equal(down.keepPrevious, true);
  assert.equal(down.log.level, 'error');
  assert.equal(down.log.msg, 'app proxy lookup failed');
  assert.equal(proxyLookupNotice(down.signature, [
    { host: 'jonbeckman-github-runner_app_proxy_1', error: 'ENOTFOUND' },
    { host: 'app_proxy', error: 'ESERVFAIL' },
  ]).log, null);
  const up = proxyLookupNotice(down.signature, [
    { host: 'jonbeckman-github-runner-app_proxy-1', ips: ['10.0.0.4'] },
  ]);
  assert.deepEqual(up.ips, ['10.0.0.4']);
  assert.equal(up.log.msg, 'app proxy resolved');
  assert.deepEqual(up.log.fields.hosts, ['jonbeckman-github-runner-app_proxy-1']);
});

test('history drops entries older than a week', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const kept = pruneHistory([
    { finishedAt: '2026-10-19T00:00:00Z' },
    { finishedAt: '2026-10-01T00:00:00Z' },
  ], { now });
  assert.equal(kept.length, 1);
});

test('compose does not publish the manager and keeps dind off the default network', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.match(compose, /PROXY_AUTH_ADD:\s*"true"/);
  assert.match(compose, /cpu_shares:\s*256/);
  const dind = compose.slice(compose.indexOf('\n  dind:\n'), compose.indexOf('\n  manager:\n'));
  assert.match(dind, /ghr_private/);
  assert.match(dind, /--data-root=\/data\/data/);
  assert.doesNotMatch(dind, /umbrel_main_network/);
  const host = compose.match(/APP_PROXY_HOST:\s*(\S+)/)[1];
  assert.deepEqual(proxyLookupHosts(host), [
    'jonbeckman-github-runner_app_proxy_1',
    'app_proxy',
    'jonbeckman-github-runner-app_proxy-1',
    'jonbeckman-github-runner-app-proxy-1',
  ]);
  assert.match(compose, /ghcr\.io\/jonbeckman\/github-runner-manager:0\.1\.2\b/);
  assert.match(compose, /ghcr\.io\/jonbeckman\/github-runner-image:0\.1\.2\b/);
});
