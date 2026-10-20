// Setup page for Grafana Alloy. Writes a 0440 River file and nothing else
// that contains the access-policy token. Node standard library only.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { chmod, chown, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSecrets, publicStatus, renderAlloy } from './render.mjs';
import { startDockerReadProxy } from './docker-ro.mjs';

const PORT = Number(process.env.PORT || 3501);
const DATA = process.env.ALLOY_DIR || '/data/alloy';
const PROXY = process.env.DOCKER_PROXY_PATH || '/ro-docker/docker.sock';
const UPSTREAM = process.env.DOCKER_HOST_SOCK || '/var/run/host-docker.sock';
const ALLOY_UID = Number(process.env.ALLOY_UID || 473);
const ALLOY_GID = Number(process.env.ALLOY_GID || 473);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(path.join(HERE, 'index.html'));
const CONFIG = path.join(DATA, 'config.alloy');
const STATUS = path.join(DATA, 'status.json');

async function writeConfig(secrets) {
  await mkdir(DATA, { recursive: true });
  const body = renderAlloy(secrets);
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: 0o440 });
  await chown(tmp, ALLOY_UID, ALLOY_GID).catch(() => {});
  await chmod(tmp, 0o440);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, CONFIG);
  await chown(CONFIG, ALLOY_UID, ALLOY_GID).catch(() => {});
  const status = publicStatus(secrets);
  await writeFile(STATUS, JSON.stringify(status, null, 2), { mode: 0o644 });
  return status;
}

async function readStatus() {
  try { return JSON.parse(await readFile(STATUS, 'utf8')); }
  catch { return { configured: false, tokenSet: false }; }
}

const proxyReady = process.env.DOCKER_PROXY === '0'
  ? Promise.resolve()
  : startDockerReadProxy({ listenPath: PROXY, upstreamPath: UPSTREAM }).catch((e) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'docker proxy failed', error: e.message }));
    });

await mkdir(DATA, { recursive: true });
try { await readFile(CONFIG); }
catch { await writeConfig(null); }

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'",
    });
    res.end(payload);
  };
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      await proxyReady;
      return send(200, { ok: true, ...(await readStatus()) });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await readStatus());
    if (req.method === 'POST' && url.pathname === '/api/secrets') {
      if (req.headers['x-ghr-request'] !== '1') return send(403, { error: 'Missing request header.' });
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 32 * 1024) return send(413, { error: 'Request too large.' });
        chunks.push(c);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const secrets = checkSecrets(body);
      const status = await writeConfig(secrets);
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'grafana cloud credentials saved' }));
      return send(200, { ...status, restart: true });
    }
    send(404, { error: 'Not found.' });
  } catch (e) {
    send(400, { error: e.message || 'error' });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'alloy setup listening', port: PORT }));
});
