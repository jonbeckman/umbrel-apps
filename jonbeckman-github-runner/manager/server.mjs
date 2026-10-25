// GitHub Runner manager. Node standard library only.
//
// Independent implementation of the Umbrel self-hosted runner design
// described in NOTICE: one JIT container per job, inside a private Docker
// daemon. Tokens stay in this process. A runner only receives its own
// single-use JIT config.
import http from 'node:http';
import { resolve4, resolve6 } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, chown, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_RUNNERS,
  IDLE_MS,
  INSTALL_ID_RE,
  MAX_JOB_MS,
  MAX_RUNNERS_LIMIT,
  allowRequest,
  backoffMs,
  bridgeGatewayIps,
  cacheEnv,
  classifyQueued,
  cpuCores,
  demuxDockerLogs,
  forkHead,
  jobLimits,
  memUsed,
  normalizeRepo,
  ownerOf,
  ownsRunner,
  parseRunnerLog,
  planSpawns,
  pruneHistory,
  proxyLookupHosts,
  proxyLookupNotice,
  reapReason,
  redact,
  renderMetrics,
  repoCacheLayout,
  runnerLabels,
  tokenHint,
  tokenKind,
} from './lib.mjs';

const PORT = Number(process.env.PORT || 3500);
const SOCK = process.env.DOCKER_SOCK || '/sock/docker.sock';
const DIND_SOCK = process.env.DIND_SOCK_PATH || '/sock/docker.sock';
const STATE_DIR = process.env.STATE_DIR || '/state';
const WORK_DIR = process.env.WORK_DIR || '/ghr';
const CACHE_DIR = process.env.CACHE_DIR || '';
const EXTERNALS_DIR = process.env.EXTERNALS_DIR || '';
const CACHE_PRUNE_MS = Number(process.env.CACHE_PRUNE_MS || 7 * 24 * 3600_000);
const IMAGE = process.env.RUNNER_IMAGE || '';
const GITHUB_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const MANUAL = process.env.MANUAL_TICK_ONLY === '1';
const RUNNER_UID = Number(process.env.RUNNER_UID || 1001);
const RUNNER_GID = Number(process.env.RUNNER_GID || RUNNER_UID);
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const LABELS = runnerLabels(ARCH);
const DOCKER_LABELS = runnerLabels(ARCH, { docker: true });
const MAX_DOCKER = 1;
const NETWORK = 'ghr-net';
const APP_PROXY_HOST = process.env.APP_PROXY_HOST || '';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PAGE = readFileSync(path.join(HERE, 'index.html'));
const SCRIPT = readFileSync(path.join(HERE, 'page.js'));
// script-src is 'self' only. The page loads /page.js; an inline script would not run.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'self'";
const SECRET_QUERY = new Set(['token', 'password', 'secret', 'access_token']);

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function log(level, msg, fields = {}) {
  console.log(redact(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })));
}

function queryHasSecret(rawUrl) {
  const raw = String(rawUrl || '');
  const q = raw.indexOf('?');
  if (q === -1) return false;
  const query = raw.slice(q + 1);
  if (/(?:^|&)(token|password|secret|access_token)=/i.test(query)) return true;
  if (/github_pat_|gh[pousr]_|glc_/i.test(query)) return true;
  try {
    const url = new URL(raw, 'http://127.0.0.1');
    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY.has(key.toLowerCase())) return true;
    }
    for (const value of url.searchParams.values()) {
      if (/github_pat_|gh[pousr]_|glc_/i.test(value)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

const DEFAULT_STATE = {
  installId: '',
  settings: { maxRunners: DEFAULT_MAX_RUNNERS, dockerForJobs: false, paused: false },
  owners: {},
  repos: [],
  history: [],
  cachePrunedAt: 0,
};
let state = structuredClone(DEFAULT_STATE);
let stateError = '';

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state = {
      ...DEFAULT_STATE,
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
      owners: parsed.owners && typeof parsed.owners === 'object' ? parsed.owners : {},
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      history: pruneHistory(Array.isArray(parsed.history) ? parsed.history : []),
    };
  } catch (e) {
    if (e.code !== 'ENOENT') stateError = e.message;
  }
}

async function saveState() {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, STATE_FILE);
}

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch((e) => log('error', 'serial task failed', { error: e.message }));
  return run;
}

function dockerRequest(method, urlPath, body, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCK,
        method,
        path: urlPath,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`docker ${method} timed out`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function dockerError(res) {
  let msg = res.body.toString().trim();
  try { msg = JSON.parse(msg).message || msg; } catch { /* plain text */ }
  const err = new Error(`docker: ${msg}`);
  err.status = res.status;
  return err;
}

async function docker(method, urlPath, body, opts) {
  const res = await dockerRequest(method, urlPath, body, opts);
  if (res.status >= 400) throw dockerError(res);
  const text = res.body.toString();
  return text ? JSON.parse(text) : null;
}

const etags = new Map();
const rate = { remaining: null, limit: 0, reset: 0 };

function githubMessage(res, data) {
  const msg = data?.message || `HTTP ${res.status}`;
  if (res.status === 401) return `GitHub rejected the token (${msg}).`;
  const need = res.headers.get('x-accepted-github-permissions');
  if (res.status === 403 && need) return `The token is missing a permission (${need}).`;
  if (res.status === 404) return 'Not found, or the token cannot see it.';
  return `GitHub: ${msg}`;
}

async function gh(method, urlPath, { owner, token, body } = {}) {
  const auth = token || state.owners[owner]?.token;
  if (!auth) throw new GitHubError(`No token for ${owner || 'request'}.`, 0);
  const url = `${GITHUB_API}${urlPath}`;
  const cacheKey = `${createHash('sha256').update(auth).digest('hex').slice(0, 8)} ${url}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${auth}`,
    'User-Agent': 'jonbeckman-github-runner',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const cached = method === 'GET' ? etags.get(cacheKey) : undefined;
  if (cached) headers['If-None-Match'] = cached.etag;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new GitHubError(`Could not reach GitHub: ${e.cause?.code || e.message}`, 0);
  }
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    rate.remaining = Number(remaining);
    rate.limit = Number(res.headers.get('x-ratelimit-limit') || 0);
    rate.reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
  }
  if (res.status === 304 && cached) return cached.body;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const err = new GitHubError(githubMessage(res, data), res.status);
    if (res.status === 401 && owner && state.owners[owner]) state.owners[owner].error = err.message;
    throw err;
  }
  if (method === 'GET' && res.headers.get('etag')) {
    if (etags.size > 1000) etags.clear();
    etags.set(cacheKey, { etag: res.headers.get('etag'), body: data });
  }
  return data;
}

const image = { present: false, pulling: false, error: '' };
let pulling = null;

async function imagePresent() {
  if (!IMAGE) throw new Error('RUNNER_IMAGE is not set');
  try {
    await docker('GET', `/images/${encodeURIComponent(IMAGE)}/json`);
    image.present = true;
    image.error = '';
  } catch (e) {
    if (e.status !== 404) throw e;
    image.present = false;
  }
  return image.present;
}

function startPull() {
  if (pulling) return;
  pulling = (async () => {
    image.pulling = true;
    image.error = '';
    try {
      const res = await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(IMAGE)}`, undefined, { timeout: 60 * 60_000 });
      if (res.status >= 400) throw dockerError(res);
      image.present = true;
      log('info', 'runner image pulled', { image: IMAGE });
    } catch (e) {
      image.error = e.message;
      log('error', 'runner image pull failed', { error: e.message });
    } finally {
      image.pulling = false;
      pulling = null;
    }
  })();
}

async function ensureNetwork() {
  try {
    await docker('GET', `/networks/${NETWORK}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    await docker('POST', '/networks/create', {
      Name: NETWORK,
      Driver: 'bridge',
      Options: {
        'com.docker.network.bridge.enable_icc': 'false',
        'com.docker.network.driver.mtu': '1450',
      },
      Labels: { 'ghr.managed': '1' },
    });
  }
}

const host = { ncpu: 0, memBytes: 0 };
async function readDaemonInfo() {
  const info = await docker('GET', '/info');
  host.ncpu = info.NCPU || 0;
  host.memBytes = info.MemTotal || 0;
}

function limits() {
  return jobLimits({ ncpu: host.ncpu, memBytes: host.memBytes, maxRunners: state.settings.maxRunners });
}

const repoStatus = new Map();
const repoBackoff = new Map();
const loggedForks = new Set();
const finishedIds = new Set();
const queuedAtByRunner = new Map();
let alive = [];
const samples = new Map();

async function ownCache(repo) {
  if (!CACHE_DIR) return { binds: [], env: [] };
  const layout = repoCacheLayout(CACHE_DIR, repo);
  await mkdir(layout.base, { recursive: true });
  for (const dir of [layout.nubStore, layout.nubCache, layout.browsers, layout.e2e, layout.toolcache, layout.xdgData, layout.xdgCache]) {
    await mkdir(dir, { recursive: true });
  }
  await chown(layout.base, RUNNER_UID, RUNNER_GID).catch(() => {});
  for (const dir of [layout.nubStore, layout.nubCache, layout.browsers, layout.e2e, layout.toolcache, layout.xdgData, layout.xdgCache]) {
    await chown(dir, RUNNER_UID, RUNNER_GID).catch(() => {});
  }
  return { binds: [`${layout.base}:${layout.base}`], env: cacheEnv(layout) };
}

async function listRunnerContainers() {
  const filters = encodeURIComponent(JSON.stringify({ label: ['ghr.runner=1'] }));
  return docker('GET', `/containers/json?all=1&filters=${filters}`);
}

async function containerLogs(id) {
  const res = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=80`);
  if (res.status >= 400) throw dockerError(res);
  return demuxDockerLogs(res.body);
}

async function refreshAlive() {
  const list = await listRunnerContainers();
  const next = [];
  for (const c of list) {
    const labels = c.Labels || {};
    let parsed = { connected: false, listening: false };
    if (c.State === 'running') {
      try { parsed = parseRunnerLog(await containerLogs(c.Id)); } catch { /* logs can lag */ }
    } else {
      try { parsed = parseRunnerLog(await containerLogs(c.Id)); } catch { /* already gone */ }
    }
    const row = {
      id: c.Id,
      name: labels['ghr.name'],
      repo: labels['ghr.repo'],
      runnerId: labels['ghr.runner-id'],
      createdAt: Number(labels['ghr.created']) || c.Created * 1000,
      docker: labels['ghr.docker'] === '1',
      state: c.State,
      busy: !!parsed.job && !parsed.result,
      job: parsed.job || '',
      result: parsed.result || '',
      jobStartedAt: parsed.jobStartedAt || '',
      jobFinishedAt: parsed.jobFinishedAt || '',
    };
    if (c.State === 'running') {
      try {
        const st = await docker('GET', `/containers/${c.Id}/stats?stream=false&one-shot=true`);
        const cur = { at: Date.now(), cpuNs: Number(st?.cpu_stats?.cpu_usage?.total_usage) || 0, mem: memUsed(st?.memory_stats) };
        const prev = samples.get(row.name);
        row.cpu = cpuCores(prev, cur);
        row.mem = cur.mem;
        samples.set(row.name, cur);
      } catch { /* stats are best-effort */ }
      next.push(row);
    } else {
      await finish(row);
    }
  }
  alive = next;
  return next;
}

async function finish(row) {
  if (finishedIds.has(row.id)) return;
  finishedIds.add(row.id);
  samples.delete(row.name);
  row.queuedAt = row.queuedAt || queuedAtByRunner.get(row.name) || '';
  queuedAtByRunner.delete(row.name);
  const ranJob = !!row.job;
  if (!ranJob && row.runnerId) {
    await deleteRegistration(row.repo, row.runnerId).catch((e) => log('error', 'deregister failed', { runner: row.name, error: e.message }));
  }
  const forced = row.stopReason;
  const result = forced || row.result || (ranJob ? 'Lost' : 'NoJob');
  const b = repoBackoff.get(row.repo) || { failures: 0, until: 0 };
  if (result === 'NoJob') {
    b.failures += 1;
    b.until = Date.now() + backoffMs(b.failures);
  } else if (ranJob) {
    b.failures = 0;
    b.until = 0;
  }
  repoBackoff.set(row.repo, b);
  const finishedAt = row.jobFinishedAt || new Date().toISOString();
  state.history = pruneHistory([{
    runner: row.name,
    repo: row.repo,
    job: row.job,
    pool: row.docker ? 'docker' : 'light',
    result,
    createdAt: new Date(row.createdAt || Date.now()).toISOString(),
    jobStartedAt: row.jobStartedAt,
    finishedAt,
    queuedAt: row.queuedAt || '',
  }, ...state.history]);
  await saveState();
  await docker('DELETE', `/containers/${row.id}?force=1`).catch(() => {});
  await rm(path.join(WORK_DIR, row.name), { recursive: true, force: true }).catch(() => {});
  log('info', 'runner finished', { runner: row.name, repo: row.repo, result });
}

async function deleteRegistration(repo, runnerId) {
  const owner = ownerOf(repo);
  try {
    await gh('DELETE', `/repos/${repo}/actions/runners/${runnerId}`, { owner });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

async function ensureExternals() {
  if (!EXTERNALS_DIR) return;
  const marker = path.join(EXTERNALS_DIR, '.image');
  const have = await readFile(marker, 'utf8').catch(() => '');
  if (have.trim() === IMAGE) return;
  await mkdir(EXTERNALS_DIR, { recursive: true });
  const created = await docker('POST', '/containers/create', {
    Image: IMAGE,
    Entrypoint: ['bash', '-c'],
    Cmd: ['set -e; rm -rf /out/*; cp -a /home/runner/externals/. /out/ 2>/dev/null || true; printf %s "$IMAGE" > /out/.image'],
    Env: [`IMAGE=${IMAGE}`],
    Labels: { 'ghr.managed': '1' },
    HostConfig: { Binds: [`${EXTERNALS_DIR}:/out`], NetworkMode: 'none' },
  });
  try {
    await docker('POST', `/containers/${created.Id}/start`);
    await docker('POST', `/containers/${created.Id}/wait`, undefined, { timeout: 5 * 60_000 });
  } finally {
    await docker('DELETE', `/containers/${created.Id}?force=1`).catch(() => {});
  }
}

async function spawn(repo, { dockerJob = false } = {}) {
  const owner = ownerOf(repo);
  const withDocker = dockerJob && !!state.settings.dockerForJobs;
  if (withDocker) await ensureExternals();
  const name = `umbrel-${state.installId}-${randomBytes(3).toString('hex')}`;
  const workDir = path.join(WORK_DIR, name);
  await mkdir(workDir, { recursive: true });
  await chown(workDir, RUNNER_UID, RUNNER_GID).catch(() => {});
  const cache = await ownCache(repo);
  const jit = await gh('POST', `/repos/${repo}/actions/runners/generate-jitconfig`, {
    owner,
    body: {
      name,
      runner_group_id: 1,
      labels: withDocker ? DOCKER_LABELS : LABELS,
      work_folder: workDir,
    },
  });
  const lim = limits();
  const spec = {
    Image: IMAGE,
    User: 'runner',
    WorkingDir: '/home/runner',
    // Image ENTRYPOINT is the same wrapper. Set both here so the image CMD
    // (the upstream run.sh) is not appended as an extra argument.
    Entrypoint: ['/usr/local/bin/jonbeckman-runner-entrypoint'],
    Cmd: [],
    Env: [
      `ACTIONS_RUNNER_INPUT_JITCONFIG=${jit.encoded_jit_config}`,
      'ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=0',
      ...cache.env,
    ],
    Labels: {
      'ghr.managed': '1',
      'ghr.runner': '1',
      'ghr.name': name,
      'ghr.repo': repo,
      'ghr.runner-id': String(jit.runner.id),
      'ghr.created': String(Date.now()),
      'ghr.docker': withDocker ? '1' : '0',
    },
    HostConfig: {
      Init: true,
      NetworkMode: withDocker ? 'host' : NETWORK,
      Memory: lim.memory,
      MemorySwap: lim.memory,
      PidsLimit: lim.pids,
      ShmSize: lim.shm,
      Binds: [`${workDir}:${workDir}`, ...cache.binds, ...(withDocker ? [`${DIND_SOCK}:/var/run/docker.sock`] : [])],
      RestartPolicy: { Name: 'no' },
    },
  };
  try {
    const created = await docker('POST', `/containers/create?name=${encodeURIComponent(`ghr-${name}`)}`, spec);
    await docker('POST', `/containers/${created.Id}/start`);
    log('info', 'runner started', { runner: name, repo, docker: withDocker, runnerId: jit.runner.id });
  } catch (e) {
    await deleteRegistration(repo, jit.runner.id).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function listRuns(repo, status) {
  const owner = ownerOf(repo);
  const runs = [];
  for (let page = 1; page <= 2; page += 1) {
    const data = await gh('GET', `/repos/${repo}/actions/runs?status=${status}&per_page=50&page=${page}`, { owner });
    const batch = data?.workflow_runs || [];
    runs.push(...batch);
    if (batch.length < 50) break;
  }
  return runs;
}

async function pollRepo(repoName) {
  const owner = ownerOf(repoName);
  const record = state.repos.find((r) => r.name === repoName);
  const info = await gh('GET', `/repos/${repoName}`, { owner });
  if (info.private !== true) {
    record.publicAt = record.publicAt || new Date().toISOString();
    await saveState();
    for (const r of alive.filter((r) => r.repo === repoName)) {
      r.stopReason = 'RepoPublic';
      await docker('POST', `/containers/${r.id}/stop?t=1`).catch(() => {});
    }
    log('warn', 'repository is public; runners stopped', { repo: repoName });
    repoStatus.set(repoName, { private: false, queued: 0, queuedDocker: 0, forks: 0, error: 'Public repositories are not served.' });
    return null;
  }
  if (record.publicAt) record.publicAt = '';
  let queued = 0;
  let queuedDocker = 0;
  let dockerOff = 0;
  let forks = 0;
  let oldestQueuedAt = '';
  let oldestDockerQueuedAt = '';
  const runs = await listRuns(repoName, 'queued');
  for (const run of runs) {
    const why = forkHead(run);
    if (why) {
      forks += 1;
      if (!loggedForks.has(run.id)) {
        loggedForks.add(run.id);
        log('info', 'skipped fork job', { repo: repoName, run: run.id, reason: why });
      }
      continue;
    }
    const data = await gh('GET', `/repos/${repoName}/actions/runs/${run.id}/jobs`, { owner });
    for (const job of data?.jobs || []) {
      if (job.status !== 'queued') continue;
      const klass = classifyQueued(job.labels, { light: LABELS, docker: DOCKER_LABELS, dockerOn: state.settings.dockerForJobs });
      const created = String(job.created_at || job.started_at || '');
      if (klass === 'light') {
        queued += 1;
        if (!oldestQueuedAt || created < oldestQueuedAt) oldestQueuedAt = created;
      } else if (klass === 'docker') {
        queuedDocker += 1;
        if (!oldestDockerQueuedAt || created < oldestDockerQueuedAt) oldestDockerQueuedAt = created;
      } else if (klass === 'docker-off') dockerOff += 1;
    }
  }
  const backoff = repoBackoff.get(repoName);
  repoStatus.set(repoName, { private: true, queued, queuedDocker, dockerOff, forks, error: state.owners[owner]?.error || '' });
  return {
    name: repoName,
    queued,
    queuedDocker,
    oldestQueuedAt,
    oldestDockerQueuedAt,
    blockedUntil: backoff?.until || 0,
  };
}

async function pruneCache() {
  if (!CACHE_DIR) return;
  if (alive.length) return;
  if (Date.now() - (state.cachePrunedAt || 0) < CACHE_PRUNE_MS) return;
  const names = await readdir(CACHE_DIR).catch(() => []);
  for (const name of names) await rm(path.join(CACHE_DIR, name), { recursive: true, force: true });
  state.cachePrunedAt = Date.now();
  await saveState();
  log('info', 'wiped idle per-repo caches');
}

async function attachQueueTimes() {
  for (const r of alive) {
    if (!r.busy || queuedAtByRunner.has(r.name)) continue;
    const owner = ownerOf(r.repo);
    const runs = await listRuns(r.repo, 'in_progress').catch(() => []);
    for (const run of runs) {
      const data = await gh('GET', `/repos/${r.repo}/actions/runs/${run.id}/jobs`, { owner }).catch(() => null);
      for (const job of data?.jobs || []) {
        if (job.runner_name === r.name && job.created_at) queuedAtByRunner.set(r.name, job.created_at);
      }
    }
  }
}

let tickError = '';

async function tick() {
  try {
    await readDaemonInfo();
    await ensureNetwork();
    if (!(await imagePresent())) {
      startPull();
      return;
    }
    await refreshAlive();
    await attachQueueTimes();
    for (const r of [...alive]) {
      const reason = reapReason(r);
      if (!reason) continue;
      r.stopReason = reason === 'timeout' ? 'TimedOut' : 'Unused';
      await docker('POST', `/containers/${r.id}/stop?t=5`).catch(() => {});
      log('info', 'runner stopped', { runner: r.name, reason });
    }
    await refreshAlive();
    await pruneCache();
    if (state.settings.paused || stateError) return;
    const plans = [];
    for (const repo of state.repos) {
      if (repo.publicAt) continue;
      const owner = ownerOf(repo.name);
      if (!state.owners[owner] || state.owners[owner].error) continue;
      try {
        const row = await pollRepo(repo.name);
        if (row) plans.push(row);
      } catch (e) {
        repoStatus.set(repo.name, { ...(repoStatus.get(repo.name) || {}), error: e.message });
        log('error', 'poll failed', { repo: repo.name, error: e.message });
      }
    }
    const spawns = planSpawns({
      repos: plans,
      runners: alive.map((r) => ({ repo: r.repo, busy: r.busy, docker: r.docker })),
      maxRunners: Math.min(MAX_RUNNERS_LIMIT, state.settings.maxRunners || 1),
      maxDocker: MAX_DOCKER,
    });
    for (const item of spawns) {
      if (item.docker && !state.settings.dockerForJobs) continue;
      try {
        await spawn(item.repo, { dockerJob: item.docker });
      } catch (e) {
        const b = repoBackoff.get(item.repo) || { failures: 0, until: 0 };
        b.failures += 1;
        b.until = Date.now() + backoffMs(b.failures);
        repoBackoff.set(item.repo, b);
        log('error', 'spawn failed', { repo: item.repo, error: e.message });
      }
    }
    tickError = '';
  } catch (e) {
    tickError = e.message;
    log('error', 'tick failed', { error: e.message });
  }
}

function nextDelay() {
  if (rate.remaining !== null && rate.remaining < 100) return Math.max(POLL_MS, rate.reset - Date.now());
  return POLL_MS;
}

let timer = null;
let stopping = false;
function schedule() {
  if (stopping || MANUAL) return;
  timer = setTimeout(() => serial(tick).finally(schedule), nextDelay());
}

function metricsSnapshot() {
  const queued = [];
  const running = [];
  for (const repo of state.repos) {
    const st = repoStatus.get(repo.name) || {};
    queued.push({ repo: repo.name, pool: 'light', count: st.queued || 0 });
    queued.push({ repo: repo.name, pool: 'docker', count: st.queuedDocker || 0 });
    running.push({ repo: repo.name, pool: 'light', count: alive.filter((r) => r.repo === repo.name && !r.docker && r.busy).length });
    running.push({ repo: repo.name, pool: 'docker', count: alive.filter((r) => r.repo === repo.name && r.docker && r.busy).length });
  }
  const finishedMap = new Map();
  const samplesByRepo = new Map();
  for (const h of state.history) {
    const key = `${h.repo}\0${h.result || 'unknown'}`;
    finishedMap.set(key, (finishedMap.get(key) || 0) + 1);
    const row = samplesByRepo.get(h.repo) || [];
    const start = Date.parse(h.jobStartedAt || '');
    const end = Date.parse(h.finishedAt || '');
    const q = Date.parse(h.queuedAt || '');
    row.push({
      repo: h.repo,
      wait: q && start >= q ? (start - q) / 1000 : undefined,
      duration: start && end > start ? (end - start) / 1000 : undefined,
    });
    samplesByRepo.set(h.repo, row);
  }
  return {
    queued,
    running,
    finished: [...finishedMap.entries()].map(([key, count]) => {
      const [repo, conclusion] = key.split('\0');
      return { repo, conclusion, count };
    }),
    samples: [...samplesByRepo.values()].flat(),
    runners: alive.filter((r) => r.busy).map((r) => ({ repo: r.repo, runner: r.name, cpu: r.cpu ?? null, mem: r.mem ?? null })),
  };
}

function publicState() {
  return {
    stateError,
    tickError,
    installId: state.installId,
    arch: ARCH,
    labels: LABELS,
    dockerLabels: DOCKER_LABELS,
    image: { ref: IMAGE, ...image },
    limits: limits(),
    host,
    settings: state.settings,
    owners: Object.entries(state.owners).map(([owner, row]) => ({
      owner,
      login: row.login || '',
      expires: row.expires || '',
      hint: tokenHint(row.token),
      error: row.error || '',
    })),
    repos: state.repos.map((r) => ({ ...r, ...(repoStatus.get(r.name) || {}) })),
    runners: alive.map((r) => ({ name: r.name, repo: r.repo, job: r.job, busy: r.busy, docker: r.docker, cpu: r.cpu ?? null, mem: r.mem ?? null })),
    history: state.history.slice(0, 30),
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new UserError('Request too large.', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new UserError('Expected JSON.'); }
}

async function verifyToken(token) {
  const kind = tokenKind(token);
  if (kind === 'classic') {
    throw new UserError('Classic tokens are refused. Create a fine-grained token (github_pat_...) limited to the private repositories this runner should serve.');
  }
  if (kind !== 'fine-grained') throw new UserError('This does not look like a fine-grained GitHub token (github_pat_...).');
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'jonbeckman-github-runner',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new UserError('GitHub rejected this token.');
  if (!res.ok) throw new UserError(`GitHub answered ${res.status} while checking the token.`, 502);
  const user = await res.json();
  return { login: user.login, expires: res.headers.get('github-authentication-token-expiration') || '' };
}

async function ownerExists(owner, token) {
  for (const kind of ['orgs', 'users']) {
    try {
      await gh('GET', `/${kind}/${owner}`, { token });
      return;
    } catch (e) {
      if (e.status === 401) throw new UserError(e.message);
      if (e.status && e.status !== 404) throw new UserError(e.message, 502);
    }
  }
  throw new UserError(`GitHub has no user or organization named ${owner}, or this token cannot see it.`);
}

async function verifyRepo(name, token) {
  const info = await gh('GET', `/repos/${name}`, { token });
  if (info.private !== true) {
    throw new UserError(`${info.full_name || name} is public. This app only serves private repositories.`);
  }
  await gh('POST', `/repos/${name}/actions/runners/registration-token`, { token });
  await gh('GET', `/repos/${name}/actions/runs?per_page=1`, { token });
  return info.full_name || name;
}

function tokenSha(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function handleApi(req, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return publicState();
  if (req.method !== 'GET' && req.headers['x-ghr-request'] !== '1') throw new UserError('Missing request header.', 403);
  const body = req.method === 'GET' ? {} : await readJson(req);
  if (req.method === 'POST' && url.pathname === '/api/tick') {
    if (!MANUAL) throw new UserError('Not found.', 404);
    await tick();
    return { ok: true };
  }
  if (req.method === 'POST' && url.pathname === '/api/owners') {
    const owner = String(body.owner || '').trim();
    if (!ownerOf(`${owner}/repo`)) throw new UserError('Owner must be a GitHub user or organization name.');
    const token = String(body.token || '').trim();
    const checked = await verifyToken(token);
    await ownerExists(owner, token);
    const sha = tokenSha(token);
    for (const [name, row] of Object.entries(state.owners)) {
      if (name !== owner && row.sha === sha) throw new UserError(`That token is already saved for ${name}.`);
    }
    state.owners[owner] = { token, login: checked.login, expires: checked.expires, sha, error: '' };
    await saveState();
    log('info', 'owner token saved', { owner, login: checked.login });
    return { ok: true };
  }
  const ownerMatch = url.pathname.match(/^\/api\/owners\/([^/]+)$/);
  if (req.method === 'DELETE' && ownerMatch) {
    const owner = decodeURIComponent(ownerMatch[1]);
    delete state.owners[owner];
    state.repos = state.repos.filter((r) => ownerOf(r.name) !== owner);
    await saveState();
    return { ok: true };
  }
  if (req.method === 'POST' && url.pathname === '/api/repos') {
    const name = normalizeRepo(body.repo);
    if (!name) throw new UserError('Use owner/repo.');
    const owner = ownerOf(name);
    const row = state.owners[owner];
    if (!row) throw new UserError(`Add a fine-grained token for ${owner} first. Tokens are per resource owner.`);
    if (state.repos.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new UserError(`${name} is already served.`);
    const full = await verifyRepo(name, row.token);
    state.repos.push({ name: full, addedAt: new Date().toISOString(), publicAt: '' });
    row.error = '';
    await saveState();
    log('info', 'repository added', { repo: full });
    return { ok: true };
  }
  const repoMatch = url.pathname.match(/^\/api\/repos\/([^/]+\/[^/]+)(?:\/(reenable))?$/);
  if (repoMatch && req.method === 'DELETE' && !repoMatch[2]) {
    const name = decodeURIComponent(repoMatch[1]);
    state.repos = state.repos.filter((r) => r.name !== name);
    await saveState();
    return { ok: true };
  }
  if (repoMatch && req.method === 'POST' && repoMatch[2] === 'reenable') {
    const name = decodeURIComponent(repoMatch[1]);
    const repo = state.repos.find((r) => r.name === name);
    if (!repo) throw new UserError('Repository is not served.', 404);
    const row = state.owners[ownerOf(name)];
    if (!row) throw new UserError(`No token for ${ownerOf(name)}.`);
    await verifyRepo(name, row.token);
    repo.publicAt = '';
    await saveState();
    return { ok: true };
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    if (body.maxRunners !== undefined) {
      if (!Number.isInteger(body.maxRunners) || body.maxRunners < 1 || body.maxRunners > MAX_RUNNERS_LIMIT) {
        throw new UserError(`Parallel jobs must be 1 to ${MAX_RUNNERS_LIMIT}.`);
      }
      state.settings.maxRunners = body.maxRunners;
    }
    if (body.paused !== undefined) state.settings.paused = !!body.paused;
    if (body.dockerForJobs !== undefined) {
      if (body.dockerForJobs && body.dockerConfirm !== 'docker') {
        throw new UserError('Type docker to confirm. Docker for jobs is root on this Umbrel.');
      }
      state.settings.dockerForJobs = !!body.dockerForJobs;
    }
    await saveState();
    return { ok: true };
  }
  if (req.method === 'POST' && url.pathname === '/api/runners/remove') {
    state.settings.paused = true;
    await saveState();
    const report = [];
    for (const repo of state.repos) {
      const owner = ownerOf(repo.name);
      try {
        const data = await gh('GET', `/repos/${repo.name}/actions/runners?per_page=100`, { owner });
        for (const r of data?.runners || []) {
          if (!ownsRunner(state.installId, r.name)) continue;
          await deleteRegistration(repo.name, r.id);
          report.push(`${repo.name}: removed ${r.name}`);
        }
      } catch (e) {
        report.push(`${repo.name}: ${e.message}`);
      }
    }
    if (!report.length) report.push('No registrations of this install were found.');
    return { ok: true, report };
  }
  throw new UserError('Not found.', 404);
}

let routeText = '';
try { routeText = readFileSync('/proc/net/route', 'utf8'); } catch { /* not linux */ }
const GATEWAYS = bridgeGatewayIps(routeText);
let proxyIps = new Set();
let proxySignature = '';
let proxyFreshUntil = 0;

// c-ares queries Docker DNS directly. musl getaddrinfo (dns.lookup) can
// reject a hostname that contains an underscore before any query is sent.
async function resolveProxyHost(host) {
  const ips = [];
  const errors = [];
  for (const resolve of [resolve4, resolve6]) {
    try {
      for (const address of await resolve(host)) ips.push(address);
    } catch (error) {
      errors.push(error);
    }
  }
  if (ips.length) return ips;
  const hard = errors.find((error) => error?.code && error.code !== 'ENOTFOUND' && error.code !== 'ENODATA');
  if (hard) throw hard;
  const missing = new Error(`ENOTFOUND ${host}`);
  missing.code = 'ENOTFOUND';
  throw missing;
}

async function refreshProxyIps() {
  const hosts = proxyLookupHosts(APP_PROXY_HOST);
  if (!hosts.length || Date.now() < proxyFreshUntil) return;
  // Claim the window before the first await so a health check and the
  // refresh timer do not both query and both log the same miss.
  proxyFreshUntil = Date.now() + 30_000;
  const results = [];
  for (const host of hosts) {
    try {
      results.push({ host, ips: await resolveProxyHost(host) });
    } catch (error) {
      results.push({ host, error: error.code || error.message });
    }
  }
  const notice = proxyLookupNotice(proxySignature, results);
  proxySignature = notice.signature;
  if (!notice.keepPrevious) proxyIps = new Set(notice.ips);
  if (notice.log) log(notice.log.level, notice.log.msg, notice.log.fields);
  proxyFreshUntil = Date.now() + (notice.keepPrevious ? 15_000 : 30_000);
}

function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    res.end(payload);
  };
  if (queryHasSecret(req.url)) {
    let path = '';
    try { path = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* omit */ }
    log('warn', 'rejected secret query', { method: req.method, path });
    return send(400, { error: 'Secrets are not accepted in the query string.' });
  }
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    url.search = '';
    const ip = clientIp(req);
    if (url.pathname !== '/metrics') await refreshProxyIps();
    if (!allowRequest(url.pathname, ip, { gateways: GATEWAYS, proxyIps })) throw new UserError('Forbidden.', 403);
    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return send(200, renderMetrics(metricsSnapshot()), 'text/plain; version=0.0.4; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(200, PAGE, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/page.js') {
      return send(200, SCRIPT, 'text/javascript; charset=utf-8');
    }
    const result = req.method === 'GET' ? await handleApi(req, url) : await serial(() => handleApi(req, url));
    return send(200, result);
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    const message = e.message || 'error';
    if (!(e instanceof UserError)) log('error', 'request failed', { error: message });
    send(status, { error: redact(message) === message ? message : 'Bad request.' });
  }
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  server.close();
  await serial(async () => {
    for (const r of [...alive]) {
      if (r.busy) continue;
      await deleteRegistration(r.repo, r.runnerId).catch(() => {});
    }
  });
  process.exit(0);
}

await loadState();
if (!INSTALL_ID_RE.test(state.installId || '')) {
  state.installId = randomBytes(2).toString('hex');
  if (!stateError) await saveState();
}
await mkdir(WORK_DIR, { recursive: true });
if (CACHE_DIR) await mkdir(CACHE_DIR, { recursive: true });
await refreshProxyIps();
if (!MANUAL) setInterval(refreshProxyIps, 30_000).unref();
server.listen(PORT, () => {
  log('info', 'manager listening', { port: PORT, image: IMAGE, labels: LABELS });
});
if (!MANUAL) serial(tick).finally(schedule);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shutdown().catch(() => process.exit(1)); });
