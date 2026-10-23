// Pure helpers for the Cursor My Machines worker. No I/O.

export const WORKER_NAME = 'umbrel';
export const MAX_WORKER_DIRS = 20;
export const KNOWN_OWNERS = ['SolZeroAI', 'jonbeckman'];

// Checkouts the worker registers on first boot. gtt-app is intentionally absent.
export const DEFAULT_REPOS = [
  'SolZeroAI/janus',
  'SolZeroAI/alchemy.new',
  'SolZeroAI/platform',
  'SolZeroAI/mahoraga-giia',
  'SolZeroAI/grokcast',
  'jonbeckman/grok-bot',
  'jonbeckman/spray',
  'jonbeckman/umbrel-apps',
];

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const DIR_RE = /^[A-Za-z0-9._-]+$/;

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

export function tokenKind(token) {
  if (/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) return 'fine-grained';
  if (/^gh[pousr]_[A-Za-z0-9]{20,}$/.test(token)) return 'classic';
  return 'unknown';
}

export function tokenFor(owners, repo) {
  const owner = ownerOf(repo);
  if (!owner || !owners) return '';
  const key = Object.keys(owners).find((item) => item.toLowerCase() === owner.toLowerCase());
  const token = key ? owners[key]?.token : '';
  return typeof token === 'string' ? token : '';
}

export function parseRepoList(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/[\n,]/);
  const repos = [];
  const errors = [];
  for (const line of lines) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const name = normalizeRepo(trimmed);
    if (!name) errors.push(`Not a repository: ${trimmed.slice(0, 80)}`);
    else if (!repos.some((repo) => repo.toLowerCase() === name.toLowerCase())) repos.push(name);
  }
  if (repos.length > MAX_WORKER_DIRS) errors.push(`A My Machines worker accepts at most ${MAX_WORKER_DIRS} directories.`);
  return { repos, errors };
}

// One directory per repo name. Two owners with the same repo name get owner__name.
export function workspaceDir(root, repo, repos) {
  const name = normalizeRepo(repo);
  if (!name) throw new Error('unsafe workspace path');
  const owner = name.slice(0, name.indexOf('/'));
  const short = name.slice(name.indexOf('/') + 1);
  const list = Array.isArray(repos) ? repos : [];
  const collision = list.some((other) => {
    const normalized = normalizeRepo(other);
    return normalized && normalized !== name && normalized.slice(normalized.indexOf('/') + 1) === short;
  });
  const dir = collision ? `${owner}__${short}` : short;
  if (!DIR_RE.test(dir) || dir.includes('..')) throw new Error('unsafe workspace path');
  return `${String(root).replace(/\/+$/, '')}/${dir}`;
}

export function githubRemote(repo) {
  const name = normalizeRepo(repo);
  if (!name) throw new Error('unsafe repository');
  return `https://github.com/${name}.git`;
}

// Worker options go before `start`. `--verbose` is a start option.
// `--pool` is omitted: this is a My Machines worker, not a team pool.
// The personal API key is CURSOR_API_KEY, not an `--api-key` argument.
// `--idle-release-timeout 0` disables idle exit. The parameters page says
// that is the default; the pool page says the default is 3600. Passing 0
// keeps the machine connected until it is stopped.
export function workerArgs({ name = WORKER_NAME, dirs, managementAddr, idleTimeout = 0, verbose = true } = {}) {
  const args = [
    'worker',
    '--name', name,
    '--idle-release-timeout', String(idleTimeout),
  ];
  if (managementAddr) args.push('--management-addr', managementAddr);
  for (const dir of dirs || []) args.push('--worker-dir', dir);
  args.push('start');
  if (verbose) args.push('--verbose');
  return args;
}

export function backoffMs(failures, base = 30_000) {
  if (failures <= 0) return 0;
  return Math.min(10 * 60_000, base * 2 ** (failures - 1));
}

// /readyz is 503 while a session is running, so "connected" is the gauge.
export function metricValue(text, metric) {
  const escaped = String(metric).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text).match(new RegExp(`^${escaped}(?:\\{[^}]*\\})?\\s+([0-9eE.+-]+)\\s*$`, 'm'));
  return match ? Number(match[1]) : null;
}

export function authFailure(text) {
  return /authentication failed|invalid username or token|could not read username|repository not found|access denied|permission denied to|the requested url returned error: 40[13]/i.test(String(text || ''));
}

export function secretValues(state) {
  const values = [];
  if (state?.cursorApiKey && state.cursorApiKey.length >= 8) values.push(state.cursorApiKey);
  for (const row of Object.values(state?.owners || {})) {
    if (row?.token && row.token.length >= 8) values.push(row.token);
  }
  return values;
}

export function redact(text, secrets = []) {
  let out = String(text);
  out = out.replace(/https:\/\/[^@\s/]+@github\.com/gi, 'https://github.com');
  out = out.replace(/[^\s"]*\?[^\s"]*/g, (url) => {
    const query = url.slice(url.indexOf('?') + 1);
    const secretKey = /(?:^|&)(token|password|secret|access_token|cursorapikey|api_key|apikey|key)=/i.test(query);
    const secretValue = /github_pat_|gh[pousr]_/i.test(query);
    return secretKey || secretValue ? url.slice(0, url.indexOf('?')) : url;
  });
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, 'gh*_ [redacted]');
}

export function clip(text, max = 300) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function fillGitCredential(input, state) {
  const fields = {};
  for (const line of String(input || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) fields[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).replace(/\r$/, '');
  }
  if (fields.protocol && fields.protocol !== 'https') return '';
  const host = (fields.host || '').toLowerCase();
  if (host && host !== 'github.com' && host !== 'github.com:443') return '';
  const repo = normalizeRepo(String(fields.path || '').replace(/^\/+/, ''));
  if (!repo) return '';
  const token = tokenFor(state?.owners || {}, repo);
  if (!token) return '';
  return `username=x-access-token\npassword=${token}\n`;
}

export function toPublic(state, runtime = {}) {
  const known = [...KNOWN_OWNERS];
  for (const owner of Object.keys(state?.owners || {})) {
    if (!known.some((item) => item.toLowerCase() === owner.toLowerCase())) known.push(owner);
  }
  return {
    stateError: runtime.stateError || '',
    cursorKey: state?.cursorApiKey ? 'key saved' : 'not set',
    owners: known.map((owner) => ({
      owner,
      token: tokenFor(state?.owners || {}, `${owner}/repo`) ? 'token saved' : 'not set',
    })),
    repos: [...(state?.repos || [])],
    worker: {
      name: WORKER_NAME,
      running: !!runtime.running,
      connected: !!runtime.connected,
      lastError: runtime.lastError || '',
      skipped: (runtime.skipped || []).map((row) => ({ repo: row.repo, error: row.error || '' })),
      dirs: [...(runtime.dirs || [])],
    },
  };
}

export function bridgeGatewayIps(routeText) {
  const ips = new Set(['127.0.0.1', '::1']);
  for (const line of String(routeText || '').trim().split('\n').slice(1)) {
    const gw = line.trim().split(/\s+/)[2];
    if (!gw || gw === '00000000' || gw.length !== 8) continue;
    const bytes = Buffer.from(gw, 'hex');
    ips.add(`${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`);
  }
  return ips;
}

// The setup page is for app_proxy, the bridge gateway, or loopback.
// There is no sibling-scrape exception: the worker's metrics stay on 127.0.0.1.
export function allowRequest(ip, { gateways, proxyIps }) {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (gateways.has(normalized) || gateways.has(ip) || proxyIps.has(normalized) || proxyIps.has(ip)) return true;
  return false;
}

const SECRET_QUERY = new Set([
  'token', 'password', 'secret', 'access_token', 'cursorapikey', 'apikey', 'api_key', 'key',
]);

export function queryHasSecret(rawUrl, secrets = []) {
  const raw = String(rawUrl || '');
  const q = raw.indexOf('?');
  if (q === -1) return false;
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && raw.includes(secret)) return true;
  }
  const query = raw.slice(q + 1);
  if (/(?:^|&)(token|password|secret|access_token|cursorApiKey|api_key|apikey|key)=/i.test(query)) return true;
  if (/github_pat_|gh[pousr]_/i.test(query)) return true;
  try {
    const url = new URL(raw, 'http://127.0.0.1');
    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY.has(key.toLowerCase())) return true;
    }
    for (const value of url.searchParams.values()) {
      if (/github_pat_|gh[pousr]_/i.test(value)) return true;
    }
    return false;
  } catch {
    return true;
  }
}
