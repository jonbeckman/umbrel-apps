// Pure helpers for the GitHub Runner manager. No I/O.

export const RUNNER_NAME_RE = /^umbrel-[0-9a-f]{4}-[0-9a-f]{6}$/;
export const INSTALL_ID_RE = /^[0-9a-f]{4}$/;
export const MAX_RUNNERS_LIMIT = 4;
export const DEFAULT_MAX_RUNNERS = 2;
export const MAX_JOB_MS = 6 * 3600_000 + 10 * 60_000;
export const IDLE_MS = 10 * 60_000;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function ownsRunner(installId, name) {
  return INSTALL_ID_RE.test(installId || '') && typeof name === 'string' && name.startsWith(`umbrel-${installId}-`) && RUNNER_NAME_RE.test(name);
}

export function normalizeRepo(input) {
  const s = String(input ?? '')
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = s.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..') return null;
  return `${owner}/${name}`;
}

export function ownerOf(repo) {
  const name = normalizeRepo(repo);
  return name ? name.slice(0, name.indexOf('/')) : null;
}

export function runnerLabels(arch, { docker = false } = {}) {
  return ['self-hosted', docker ? 'umbrel-docker' : 'umbrel', 'Linux', arch === 'arm64' ? 'ARM64' : 'X64'];
}

export function jobWantsUs(jobLabels, labels) {
  const have = new Set(labels.map((l) => l.toLowerCase()));
  const want = (jobLabels || []).map((l) => String(l).toLowerCase());
  return want.some((l) => l === 'umbrel' || l === 'umbrel-docker') && want.every((l) => have.has(l));
}

export function forkHead(run) {
  const head = run?.head_repository;
  if (!head) return 'it has no head repository';
  if (head.fork === true) return `its head repository ${head.full_name || ''} is a fork`.trim();
  if (run.repository && head.id != null && head.id !== run.repository.id) {
    return `its head repository ${head.full_name || head.id} is not ${run.repository.full_name || run.repository.id}`;
  }
  return '';
}

export function classifyQueued(jobLabels, { light, docker, dockerOn }) {
  const want = (jobLabels || []).map((l) => String(l).toLowerCase());
  if (jobWantsUs(jobLabels, light)) return 'light';
  if (jobWantsUs(jobLabels, docker)) return dockerOn ? 'docker' : 'docker-off';
  if (want.includes('umbrel') || want.includes('umbrel-docker')) return 'mismatch';
  return '';
}

export function planSpawns({ repos, runners, maxRunners, maxDocker = 1, now = Date.now() }) {
  let free = maxRunners - runners.length;
  let freeDocker = maxDocker - runners.filter((r) => r.docker).length;
  if (free <= 0) return [];
  const key = (repo, docker) => `${docker ? 'd' : 'l'}:${repo}`;
  const idle = new Map();
  for (const r of runners) if (!r.busy) idle.set(key(r.repo, r.docker), (idle.get(key(r.repo, r.docker)) || 0) + 1);
  const wants = repos
    .filter((r) => !(r.blockedUntil > now))
    .flatMap((r) => [
      { repo: r.name, docker: false, need: (r.queued || 0) - (idle.get(key(r.name, false)) || 0), oldest: r.oldestQueuedAt || '' },
      { repo: r.name, docker: true, need: (r.queuedDocker || 0) - (idle.get(key(r.name, true)) || 0), oldest: r.oldestDockerQueuedAt || '' },
    ])
    .filter((w) => w.need > 0)
    .sort((a, b) => a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : 0);
  const out = [];
  while (free > 0) {
    let progressed = false;
    for (const w of wants) {
      if (free > 0 && w.need > 0 && (!w.docker || freeDocker > 0)) {
        out.push({ repo: w.repo, docker: w.docker });
        w.need -= 1;
        free -= 1;
        if (w.docker) freeDocker -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const GiB = 1024 ** 3;

export function jobLimits({ ncpu, memBytes, maxRunners }) {
  const cap = clamp(Math.floor(maxRunners) || 1, 1, MAX_RUNNERS_LIMIT);
  const cpus = Math.max(1, Math.floor(ncpu || 2));
  const memory = clamp(Math.floor((memBytes || 4 * GiB) / 2 / cap), GiB, 8 * GiB);
  return { cpus, memory, pids: 4096, shm: Math.min(GiB, Math.floor(memory / 4)) };
}

export function reapReason({ createdAt, busy }, { now = Date.now(), idleMs = IDLE_MS, maxJobMs = MAX_JOB_MS } = {}) {
  const age = now - createdAt;
  if (age > maxJobMs) return 'timeout';
  if (!busy && age > idleMs) return 'idle';
  return '';
}

export function backoffMs(failures) {
  if (failures <= 0) return 0;
  return Math.min(10 * 60_000, 30_000 * 2 ** (failures - 1));
}

export function tokenKind(token) {
  if (/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) return 'fine-grained';
  if (/^gh[pousr]_[A-Za-z0-9]{20,}$/.test(token)) return 'classic';
  return 'unknown';
}

export function tokenHint(token) {
  if (!token || token.length < 4) return '';
  return `…${token.slice(-4)}`;
}

// Per-repo cache on the Umbrel disk. Never shared across repositories.
// Nub's content store is npm_config_store_dir + "/v1" (see nub store path).
// Nub's metadata cache is NUB_CACHE_DIR. Playwright browsers follow
// PLAYWRIGHT_BROWSERS_PATH. tester-army e2e replays follow E2E_CACHE_DIR.
export function repoCacheLayout(cacheRoot, repo) {
  const safe = String(repo).replaceAll('/', '__');
  const base = `${cacheRoot.replace(/\/+$/, '')}/${safe}`;
  return {
    base,
    nubStore: `${base}/nub-store`,
    nubCache: `${base}/nub-cache`,
    browsers: `${base}/ms-playwright`,
    e2e: `${base}/e2e`,
    toolcache: `${base}/toolcache`,
    xdgData: `${base}/xdg-data`,
    xdgCache: `${base}/xdg-cache`,
  };
}

export function cacheEnv(layout) {
  return [
    `npm_config_store_dir=${layout.nubStore}`,
    `NUB_CACHE_DIR=${layout.nubCache}`,
    `PLAYWRIGHT_BROWSERS_PATH=${layout.browsers}`,
    `E2E_CACHE_DIR=${layout.e2e}`,
    `RUNNER_TOOL_CACHE=${layout.toolcache}`,
    `XDG_DATA_HOME=${layout.xdgData}`,
    `XDG_CACHE_HOME=${layout.xdgCache}`,
  ];
}

const STAMP = String.raw`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z)`;
const RUNNING_RE = new RegExp(`^${STAMP}: Running job: (.+)$`, 'm');
const DONE_RE = new RegExp(`^${STAMP}: Job (.+) completed with result: (\\w+)$`, 'm');

export function parseRunnerLog(text) {
  const out = { connected: /Connected to GitHub/.test(text), listening: /Listening for Jobs/.test(text) };
  const run = text.match(RUNNING_RE);
  if (run) Object.assign(out, { job: run[2].trim(), jobStartedAt: run[1].replace(' ', 'T') });
  const done = text.match(DONE_RE);
  if (done) Object.assign(out, { result: done[3], jobFinishedAt: done[1].replace(' ', 'T') });
  return out;
}

export function demuxDockerLogs(buf) {
  const parts = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const type = buf[o];
    if (type > 2 || buf[o + 1] || buf[o + 2] || buf[o + 3]) return buf.toString();
    const size = buf.readUInt32BE(o + 4);
    if (o + 8 + size > buf.length) break;
    parts.push(buf.subarray(o + 8, o + 8 + size));
    o += 8 + size;
  }
  if (o === 0) return buf.toString();
  return Buffer.concat(parts).toString();
}

export function memUsed(memoryStats) {
  const usage = Number(memoryStats?.usage) || 0;
  const cache = Number(memoryStats?.stats?.inactive_file ?? memoryStats?.stats?.total_inactive_file) || 0;
  return Math.max(0, usage - cache);
}

export function cpuCores(prev, cur) {
  if (!prev || !(cur.at > prev.at)) return null;
  const used = Math.max(0, cur.cpuNs - prev.cpuNs);
  return used / 1e6 / (cur.at - prev.at);
}

export function pruneHistory(history, { now = Date.now(), maxAgeMs = 7 * 24 * 3600_000, maxEntries = 2000 } = {}) {
  return history.filter((h) => !(now - Date.parse(h.finishedAt || 0) > maxAgeMs)).slice(0, maxEntries);
}

const HISTOGRAM_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 21600];

function esc(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function labels(obj) {
  const keys = Object.keys(obj).sort();
  if (!keys.length) return '';
  return `{${keys.map((k) => `${k}="${esc(obj[k])}"`).join(',')}}`;
}

function histogramLines(name, labelObj, values) {
  const lines = [];
  const nums = values.filter((v) => Number.isFinite(v) && v >= 0);
  let sum = 0;
  for (const v of nums) sum += v;
  for (const le of HISTOGRAM_BUCKETS) {
    const count = nums.filter((v) => v <= le).length;
    lines.push(`${name}_bucket${labels({ ...labelObj, le: String(le) })} ${count}`);
  }
  lines.push(`${name}_bucket${labels({ ...labelObj, le: '+Inf' })} ${nums.length}`);
  lines.push(`${name}_sum${labels(labelObj)} ${sum}`);
  lines.push(`${name}_count${labels(labelObj)} ${nums.length}`);
  return lines;
}

// Prometheus text from a snapshot. No tokens, no job logs.
export function renderMetrics(snap) {
  const lines = [
    '# HELP ghr_up 1 when the manager is serving metrics.',
    '# TYPE ghr_up gauge',
    'ghr_up 1',
    '# HELP ghr_jobs_queued Queued jobs this manager will run, by repo and pool.',
    '# TYPE ghr_jobs_queued gauge',
  ];
  for (const row of snap.queued || []) lines.push(`ghr_jobs_queued${labels({ repo: row.repo, pool: row.pool })} ${row.count}`);
  lines.push('# HELP ghr_jobs_running Runner containers currently in a job, by repo and pool.', '# TYPE ghr_jobs_running gauge');
  for (const row of snap.running || []) lines.push(`ghr_jobs_running${labels({ repo: row.repo, pool: row.pool })} ${row.count}`);
  lines.push('# HELP ghr_jobs_finished_total Jobs recorded by this manager, by repo and conclusion.', '# TYPE ghr_jobs_finished_total counter');
  for (const row of snap.finished || []) lines.push(`ghr_jobs_finished_total${labels({ repo: row.repo, conclusion: row.conclusion })} ${row.count}`);
  const waits = new Map();
  const durations = new Map();
  for (const sample of snap.samples || []) {
    if (!waits.has(sample.repo)) waits.set(sample.repo, []);
    if (!durations.has(sample.repo)) durations.set(sample.repo, []);
    if (Number.isFinite(sample.wait)) waits.get(sample.repo).push(sample.wait);
    if (Number.isFinite(sample.duration)) durations.get(sample.repo).push(sample.duration);
  }
  const repos = [...new Set([...waits.keys(), ...durations.keys()])].sort();
  if (repos.length) {
    lines.push(
      '# HELP ghr_job_queue_wait_seconds Seconds from GitHub queue time to job start.',
      '# TYPE ghr_job_queue_wait_seconds histogram',
      '# HELP ghr_job_duration_seconds Seconds from job start to the manager recording it finished.',
      '# TYPE ghr_job_duration_seconds histogram',
    );
  }
  for (const repo of repos) {
    lines.push(...histogramLines('ghr_job_queue_wait_seconds', { repo }, waits.get(repo) || []));
    lines.push(...histogramLines('ghr_job_duration_seconds', { repo }, durations.get(repo) || []));
  }
  lines.push('# HELP ghr_runner_cpu_cores Last CPU cores sample for a live runner container.', '# TYPE ghr_runner_cpu_cores gauge');
  lines.push('# HELP ghr_runner_memory_bytes Last memory sample for a live runner container, cache excluded.', '# TYPE ghr_runner_memory_bytes gauge');
  for (const row of snap.runners || []) {
    const lab = labels({ repo: row.repo, runner: row.runner });
    if (row.cpu != null) lines.push(`ghr_runner_cpu_cores${lab} ${row.cpu}`);
    if (row.mem != null) lines.push(`ghr_runner_memory_bytes${lab} ${row.mem}`);
  }
  return `${lines.join('\n')}\n`;
}

export function bridgeGatewayIps(routeText) {
  const ips = new Set(['127.0.0.1', '::1']);
  for (const line of String(routeText || '').trim().split('\n').slice(1)) {
    const gw = line.trim().split(/\s+/)[2];
    if (!gw || gw === '00000000' || gw.length !== 8) continue;
    const b = Buffer.from(gw, 'hex');
    ips.add(`${b[3]}.${b[2]}.${b[1]}.${b[0]}`);
  }
  return ips;
}

// /metrics is for sibling containers (Grafana Alloy). Everything else is
// the setup page: app_proxy, the bridge gateway, or loopback.
export function allowRequest(pathname, ip, { gateways, proxyIps }) {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (pathname === '/metrics') return true;
  if (gateways.has(normalized) || gateways.has(ip) || proxyIps.has(normalized) || proxyIps.has(ip)) return true;
  return false;
}

export function redact(text) {
  // Drop a query string that carries a secret before anything else sees it.
  // Replacing the value in place would still log a request URL with a secret.
  const stripped = String(text).replace(/[^\s"]*\?[^\s"]*/g, (url) => {
    const query = url.slice(url.indexOf('?') + 1);
    const secretKey = /(?:^|&)(token|password|secret|access_token|promurl|promuser|lokiurl|lokiuser|otlpurl|otlpuser)=/i.test(query);
    const secretValue = /github_pat_|gh[pousr]_|glc_/i.test(query);
    return secretKey || secretValue ? url.slice(0, url.indexOf('?')) : url;
  });
  return stripped
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, 'gh*_ [redacted]')
    .replace(/\bglc_[A-Za-z0-9_]+\b/g, 'glc_[redacted]');
}
