// Setup page and My Machines worker supervisor. Node standard library only.
//
// The personal Cursor API key and the GitHub tokens stay in state.json
// (mode 0600). The worker process receives the Cursor key as CURSOR_API_KEY.
// Git remotes stay https://github.com/owner/repo.git with no token in them;
// a credential helper reads the token file when git asks.
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REPOS,
  WORKER_NAME,
  allowRequest,
  authFailure,
  backoffMs,
  bridgeGatewayIps,
  clip,
  githubRemote,
  normalizeRepo,
  ownerOf,
  parseRepoList,
  queryHasSecret,
  redact,
  secretValues,
  tokenFor,
  tokenKind,
  toPublic,
  workerArgs,
  metricValue,
  workspaceDir,
} from './lib.mjs';

const PORT = Number(process.env.PORT || 3502);
const STATE_DIR = process.env.STATE_DIR || '/state';
const STATE_FILE = process.env.CURSOR_WORKER_STATE || path.join(STATE_DIR, 'state.json');
const WORKSPACES = process.env.WORKSPACES_DIR || '/workspaces';
const MANAGEMENT = process.env.MANAGEMENT_ADDR || '127.0.0.1:4646';
const BACKOFF_BASE = Number(process.env.WORKER_BACKOFF_BASE_MS || 30_000);
const METRICS_POLL_MS = Number(process.env.METRICS_POLL_MS || 2000);
const STOP_MS = Number(process.env.WORKER_STOP_MS || 5000);
const GITHUB_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const APP_PROXY_HOST = process.env.APP_PROXY_HOST || '';
const AUTOSTART = process.env.WORKER_AUTOSTART !== '0';
const HOME = process.env.HOME || '/home/cursor';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(path.join(HERE, 'index.html'));
const SCRIPT = readFileSync(path.join(HERE, 'page.js'));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'self'";

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

let state = { cursorApiKey: '', owners: {}, repos: [...DEFAULT_REPOS] };
let stateError = '';
const runtime = {
  running: false,
  connected: false,
  lastError: '',
  skipped: [],
  dirs: [],
  failures: 0,
};

function log(level, msg, fields = {}) {
  const line = redact(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }), secretValues(state));
  console.log(line);
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state = {
      cursorApiKey: typeof parsed.cursorApiKey === 'string' ? parsed.cursorApiKey : '',
      owners: {},
      repos: Array.isArray(parsed.repos) ? parsed.repos.map(normalizeRepo).filter(Boolean).slice(0, 20) : [...DEFAULT_REPOS],
    };
    if (parsed.owners && typeof parsed.owners === 'object') {
      for (const [owner, row] of Object.entries(parsed.owners)) {
        if (!ownerOf(`${owner}/repo`)) continue;
        if (typeof row?.token === 'string' && row.token) state.owners[owner] = { token: row.token };
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      stateError = 'Could not read saved settings.';
      log('error', 'state unreadable');
      return;
    }
    state = { cursorApiKey: '', owners: {}, repos: [...DEFAULT_REPOS] };
    await saveState();
  }
}

async function saveState() {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await chmod(path.dirname(STATE_FILE), 0o700).catch(() => {});
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, STATE_FILE);
  await chmod(STATE_FILE, 0o600);
}

function toolEnv() {
  const env = { ...process.env, HOME, GIT_TERMINAL_PROMPT: '0', CURSOR_WORKER_STATE: STATE_FILE };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key];
    if (/API_KEY/i.test(key)) delete env[key];
  }
  delete env.GITHUB_PAT;
  delete env.GH_PAT;
  return env;
}

function agentEnv() {
  const env = toolEnv();
  env.CURSOR_API_KEY = state.cursorApiKey;
  return env;
}

function command(binEnv, scriptEnv, fallback, args) {
  if (process.env[scriptEnv]) return { cmd: process.execPath, args: [process.env[scriptEnv], ...args] };
  return { cmd: process.env[binEnv] || fallback, args };
}

function runGit(args) {
  const { cmd, args: argv } = command('GIT_BIN', 'GIT_NODE_SCRIPT', 'git', args);
  const timeoutMs = Number(process.env.GIT_TIMEOUT_MS || 120_000);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { env: toolEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git exited ${code}`));
    });
  });
}

async function configureGit() {
  if (process.env.GIT_CONFIG === '0') return;
  const pairs = [
    ['credential.helper', '/usr/local/bin/git-credential-cursor'],
    ['credential.useHttpPath', 'true'],
    ['safe.directory', '*'],
  ];
  for (const [key, value] of pairs) {
    try { await runGit(['config', '--global', key, value]); }
    catch (e) { log('warn', 'git config failed', { key, error: clip(redact(e.message, secretValues(state))) }); }
  }
}

async function isGitCheckout(dir) {
  try {
    await access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

const gitAuth = [
  '-c', 'credential.helper=/usr/local/bin/git-credential-cursor',
  '-c', 'credential.useHttpPath=true',
];

async function syncRepo(repo) {
  const dir = workspaceDir(WORKSPACES, repo, state.repos);
  const url = githubRemote(repo);
  let exists = false;
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { ok: false, dir, error: 'path exists and is not a directory' };
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, dir, error: e.message };
  }
  if (exists && !(await isGitCheckout(dir))) {
    return { ok: false, dir, error: 'path exists but is not a git checkout' };
  }
  if (!exists) {
    try {
      await mkdir(WORKSPACES, { recursive: true });
      await runGit([...gitAuth, 'clone', '--origin', 'origin', url, dir]);
      return { ok: true, dir };
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, dir, error: e.message };
    }
  }
  try {
    await runGit(['-C', dir, 'remote', 'set-url', 'origin', url]);
  } catch (e) {
    return { ok: false, dir, error: e.message };
  }
  try {
    await runGit(['-C', dir, ...gitAuth, 'fetch', '--prune', 'origin']);
    return { ok: true, dir };
  } catch (e) {
    if (authFailure(e.message) || !tokenFor(state.owners, repo)) return { ok: false, dir, error: e.message };
    log('warn', 'fetch failed; using the existing checkout', { repo, error: clip(redact(e.message, secretValues(state))) });
    return { ok: true, dir };
  }
}

async function prepareAll() {
  const skipped = [];
  const dirs = [];
  for (const repo of state.repos) {
    try {
      const result = await syncRepo(repo);
      if (result.ok) dirs.push(result.dir);
      else {
        const error = clip(redact(result.error || 'skipped', secretValues(state)));
        skipped.push({ repo, error });
        log('warn', 'skipping repository', { repo, error });
      }
    } catch (e) {
      const error = clip(redact(e.message || 'skipped', secretValues(state)));
      skipped.push({ repo, error });
      log('warn', 'skipping repository', { repo, error });
    }
  }
  return { dirs, skipped };
}

let generation = 0;
let child = null;
let output = '';
let expectedStop = false;
let backoffTimer = null;
let metricsTimer = null;
let chain = Promise.resolve();
let stopping = false;

function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch((e) => log('error', 'worker loop failed', { error: clip(redact(e.message || '', secretValues(state))) }));
  return run;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once('exit', resolve));
}

async function stopChild() {
  const proc = child;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    child = null;
    runtime.running = false;
    runtime.connected = false;
    clearInterval(metricsTimer);
    return;
  }
  expectedStop = true;
  try { process.kill(-proc.pid, 'SIGTERM'); }
  catch { try { proc.kill('SIGTERM'); } catch { /* already gone */ } }
  await Promise.race([onceExit(proc), sleep(STOP_MS)]);
  if (proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(-proc.pid, 'SIGKILL'); }
    catch { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }
    await Promise.race([onceExit(proc), sleep(STOP_MS)]);
  }
  expectedStop = false;
  if (child === proc) child = null;
  runtime.running = false;
  runtime.connected = false;
  clearInterval(metricsTimer);
}

function noteLine(line) {
  const clean = clip(redact(line, secretValues(state)));
  if (!clean) return;
  log('info', 'worker', { line: clean });
  if (/error|fail|unauthorized|denied|invalid/i.test(clean)) runtime.lastError = clean;
}

function takeOutput(chunk) {
  output += chunk.toString();
  let idx;
  while ((idx = output.indexOf('\n')) >= 0) {
    const line = output.slice(0, idx);
    output = output.slice(idx + 1);
    noteLine(line);
  }
  if (output.length > 8192) {
    const pending = output;
    output = '';
    noteLine(pending);
  }
}

async function pollMetrics(proc) {
  if (child !== proc) return;
  try {
    const res = await fetch(`http://${MANAGEMENT}/metrics`, { signal: AbortSignal.timeout(1000) });
    const text = await res.text();
    const value = metricValue(text, 'cursor_self_hosted_worker_connected');
    if (child !== proc || value === null) return;
    runtime.connected = value === 1;
    if (runtime.connected) runtime.lastError = '';
  } catch { /* keep the last sample until the process exits */ }
}

function spawnWorker(dirs, gen) {
  const args = workerArgs({ name: WORKER_NAME, dirs, managementAddr: MANAGEMENT, idleTimeout: 0, verbose: true });
  const { cmd, args: argv } = command('AGENT_BIN', 'AGENT_NODE_SCRIPT', 'agent', args);
  log('info', 'worker starting', { args });
  const proc = spawn(cmd, argv, { env: agentEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  output = '';
  runtime.running = true;
  runtime.connected = false;
  proc.stdout.on('data', takeOutput);
  proc.stderr.on('data', takeOutput);
  proc.on('error', (err) => {
    runtime.lastError = clip(redact(err.message, secretValues(state)));
    log('error', 'worker spawn failed', { error: runtime.lastError });
  });
  proc.on('exit', (code) => {
    if (child === proc) child = null;
    clearInterval(metricsTimer);
    runtime.running = false;
    runtime.connected = false;
    if (expectedStop || gen !== generation || stopping) return;
    if (!runtime.lastError) runtime.lastError = `Worker exited (${code}).`;
    const delay = retryLater(gen);
    log('info', 'worker exited', { code, delay });
  });
  clearInterval(metricsTimer);
  metricsTimer = setInterval(() => { pollMetrics(proc).catch(() => {}); }, METRICS_POLL_MS);
  pollMetrics(proc).catch(() => {});
}

function retryLater(gen) {
  runtime.failures += 1;
  const delay = backoffMs(runtime.failures, BACKOFF_BASE);
  clearTimeout(backoffTimer);
  backoffTimer = setTimeout(() => {
    if (gen === generation) serial(() => startAttempt(gen));
  }, delay);
  return delay;
}

async function startAttempt(gen) {
  clearTimeout(backoffTimer);
  try {
    await stopChild();
    if (gen !== generation || stopping) return;
    if (!state.cursorApiKey) {
      runtime.running = false;
      runtime.connected = false;
      runtime.dirs = [];
      runtime.skipped = [];
      runtime.lastError = '';
      return;
    }
    const prepared = await prepareAll();
    if (gen !== generation || stopping) return;
    runtime.skipped = prepared.skipped;
    runtime.dirs = prepared.dirs;
    if (!prepared.dirs.length) {
      runtime.running = false;
      runtime.connected = false;
      runtime.lastError = clip(prepared.skipped.map((row) => `${row.repo}: ${row.error}`).join(' ')) || 'No repositories could be prepared.';
      const delay = retryLater(gen);
      log('info', 'no repositories ready', { delay });
      return;
    }
    runtime.lastError = '';
    spawnWorker(prepared.dirs, gen);
  } catch (e) {
    if (gen !== generation || stopping) return;
    runtime.running = false;
    runtime.connected = false;
    runtime.lastError = clip(redact(e.message || 'worker failed', secretValues(state)));
    const delay = retryLater(gen);
    log('error', 'worker prepare failed', { error: runtime.lastError, delay });
  }
}

function kick() {
  generation += 1;
  runtime.failures = 0;
  clearTimeout(backoffTimer);
  const gen = generation;
  return serial(() => startAttempt(gen));
}

async function github(pathname, token) {
  let res;
  try {
    res = await fetch(`${GITHUB_API}${pathname}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'jonbeckman-cursor-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new UserError(`Could not reach GitHub: ${e.cause?.code || e.message}`, 502);
  }
  if (res.status === 401) {
    await res.text().catch(() => '');
    const err = new UserError('GitHub rejected this token.');
    err.status = 401;
    throw err;
  }
  if (res.status === 404) {
    await res.text().catch(() => '');
    const err = new UserError('Not found, or the token cannot see it.');
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    await res.text().catch(() => '');
    throw new UserError(`GitHub answered ${res.status} while checking the token.`, 502);
  }
  return res.json();
}

async function verifyToken(token) {
  const kind = tokenKind(token);
  if (kind === 'classic') {
    throw new UserError('Classic tokens are refused. Create a fine-grained token (github_pat_...) limited to the repositories this worker should serve.');
  }
  if (kind !== 'fine-grained') throw new UserError('This does not look like a fine-grained GitHub token (github_pat_...).');
  await github('/user', token);
}

async function ownerExists(owner, token) {
  for (const kind of ['orgs', 'users']) {
    try {
      await github(`/${kind}/${owner}`, token);
      return;
    } catch (e) {
      if (e.status === 401) throw new UserError(e.message);
      if (e.status && e.status !== 404) throw new UserError(e.message, e.status >= 500 ? 502 : 400);
    }
  }
  throw new UserError(`GitHub has no user or organization named ${owner}, or this token cannot see it.`);
}

function publicBody() {
  const body = toPublic(state, { ...runtime, stateError });
  const raw = JSON.stringify(body);
  for (const secret of secretValues(state)) {
    if (raw.includes(secret)) return { error: 'status suppressed' };
  }
  return body;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new UserError('Request too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new UserError('Expected JSON.'); }
}

async function applySave(body) {
  let cursorApiKey = String(body.cursorApiKey || '').trim();
  if (!cursorApiKey) cursorApiKey = state.cursorApiKey;
  if (!cursorApiKey) throw new UserError('Cursor API key is required.');
  if (cursorApiKey.length > 500 || /[\r\n]/.test(cursorApiKey)) throw new UserError('Cursor API key is not valid.');
  if (tokenKind(cursorApiKey) !== 'unknown') throw new UserError('That looks like a GitHub token. Paste a personal Cursor API key.');

  const nextOwners = {};
  for (const [owner, row] of Object.entries(state.owners)) nextOwners[owner] = { token: row.token };
  if (!Array.isArray(body.owners)) throw new UserError('Expected a list of owners.');
  for (const row of body.owners) {
    const owner = String(row?.owner || '').trim();
    const token = String(row?.token || '').trim();
    if (!owner && !token) continue;
    if (!ownerOf(`${owner}/repo`)) throw new UserError('Owner must be a GitHub user or organization name.');
    if (!token) continue;
    await verifyToken(token);
    await ownerExists(owner, token);
    const duplicate = Object.entries(nextOwners).find(([name, saved]) => name !== owner && saved.token === token);
    if (duplicate) throw new UserError(`That token is already saved for ${duplicate[0]}.`);
    nextOwners[owner] = { token };
  }

  const parsed = parseRepoList(body.repos);
  if (parsed.errors.length) throw new UserError(parsed.errors[0]);

  state = { cursorApiKey, owners: nextOwners, repos: parsed.repos };
  await saveState();
  log('info', 'settings saved', { repos: state.repos.length, owners: Object.keys(state.owners) });
  // kick() queues the restart on the same serial chain. Awaiting it from
  // this request would wait for the chain slot this request still holds.
  kick();
}

async function handleApi(req, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return publicBody();
  if (req.method !== 'GET' && req.headers['x-ghr-request'] !== '1') throw new UserError('Missing request header.', 403);
  const body = req.method === 'GET' ? {} : await readJson(req);
  if (req.method === 'POST' && url.pathname === '/api/save') {
    await applySave(body);
    return { ok: true, ...publicBody() };
  }
  const ownerMatch = url.pathname.match(/^\/api\/owners\/([^/]+)$/);
  if (req.method === 'DELETE' && ownerMatch) {
    const owner = decodeURIComponent(ownerMatch[1]);
    const key = Object.keys(state.owners).find((item) => item.toLowerCase() === owner.toLowerCase());
    if (key) delete state.owners[key];
    await saveState();
    log('info', 'owner token removed', { owner });
    kick();
    return { ok: true, ...publicBody() };
  }
  throw new UserError('Not found.', 404);
}

let routeText = '';
try { routeText = readFileSync('/proc/net/route', 'utf8'); } catch { /* not linux */ }
const GATEWAYS = bridgeGatewayIps(routeText);
let proxyIps = new Set();

async function refreshProxyIps() {
  if (!APP_PROXY_HOST) return;
  try {
    proxyIps = new Set((await lookup(APP_PROXY_HOST, { all: true })).map((item) => item.address));
  } catch (e) {
    log('error', 'app proxy lookup failed', { host: APP_PROXY_HOST, error: e.code || e.message });
  }
}

function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
    const safe = type.startsWith('application/json')
      ? redact(payload, secretValues(state))
      : payload;
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    res.end(safe);
  };
  if (queryHasSecret(req.url, secretValues(state))) {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* omit */ }
    log('warn', 'rejected secret query', { method: req.method, path: pathname });
    return send(400, { error: 'Secrets are not accepted in the query string.' });
  }
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    url.search = '';
    if (url.pathname !== '/healthz') await refreshProxyIps();
    if (!allowRequest(clientIp(req), { gateways: GATEWAYS, proxyIps })) throw new UserError('Forbidden.', 403);
    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
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
    const message = clip(redact(e.message || 'error', secretValues(state)));
    if (!(e instanceof UserError)) log('error', 'request failed', { error: message });
    send(status, { error: message === redact(message, secretValues(state)) ? message : 'Bad request.' });
  }
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  generation += 1;
  clearTimeout(backoffTimer);
  clearInterval(metricsTimer);
  server.close();
  await stopChild().catch(() => {});
  process.exit(0);
}

try {
  await mkdir(WORKSPACES, { recursive: true });
  await loadState();
  await configureGit();
} catch (e) {
  stateError = 'Could not write the app data directory.';
  log('error', 'startup failed', { error: clip(redact(e.message || '', secretValues(state))) });
}
await refreshProxyIps();
server.listen(PORT, () => {
  log('info', 'cursor worker setup listening', { port: PORT, worker: WORKER_NAME });
  if (AUTOSTART) kick();
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shutdown().catch(() => process.exit(1)); });
