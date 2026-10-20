import http from 'node:http';
import fs from 'node:fs';

export async function createFakeDocker() {
  const containers = new Map();
  let seq = 1;
  const socketPath = `/tmp/ghr-fake-docker-${process.pid}-${Date.now()}.sock`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const json = () => (raw ? JSON.parse(raw) : {});
    const send = (status, body) => {
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };
    if (req.method === 'GET' && url.pathname === '/info') return send(200, { NCPU: 4, MemTotal: 8 * 1024 ** 3 });
    if (req.method === 'GET' && url.pathname.startsWith('/images/') && url.pathname.endsWith('/json')) return send(200, { Id: 'sha256:image' });
    if (req.method === 'POST' && url.pathname === '/images/create') return send(200, '');
    if (req.method === 'GET' && url.pathname === '/networks/ghr-net') return send(200, { Name: 'ghr-net' });
    if (req.method === 'POST' && url.pathname === '/networks/create') return send(201, { Id: 'net' });
    if (req.method === 'POST' && url.pathname === '/containers/create') {
      const id = `c${seq++}`;
      const body = json();
      containers.set(id, { Id: id, State: 'created', Labels: body.Labels || {}, body, Created: Date.now() / 1000 });
      return send(201, { Id: id });
    }
    const start = url.pathname.match(/^\/containers\/([^/]+)\/start$/);
    if (req.method === 'POST' && start) {
      const row = containers.get(start[1]);
      if (!row) return send(404, { message: 'no such container' });
      row.State = 'running';
      return send(204, '');
    }
    const stop = url.pathname.match(/^\/containers\/([^/]+)\/stop$/);
    if (req.method === 'POST' && stop) {
      const row = containers.get(stop[1]);
      if (row) row.State = 'exited';
      return send(204, '');
    }
    const logs = url.pathname.match(/^\/containers\/([^/]+)\/logs$/);
    if (req.method === 'GET' && logs) {
      const row = containers.get(logs[1]);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(row?.logs || '√ Connected to GitHub\n2026-10-20 00:00:00Z: Listening for Jobs\n');
      return;
    }
    const stats = url.pathname.match(/^\/containers\/([^/]+)\/stats$/);
    if (req.method === 'GET' && stats) {
      return send(200, { cpu_stats: { cpu_usage: { total_usage: 1e9 } }, memory_stats: { usage: 50_000_000, limit: 2e9, stats: { inactive_file: 1_000_000 } } });
    }
    if (req.method === 'GET' && url.pathname === '/containers/json') {
      return send(200, [...containers.values()].map((c) => ({ Id: c.Id, State: c.State, Labels: c.Labels, Created: c.Created })));
    }
    const del = url.pathname.match(/^\/containers\/([^/]+)$/);
    if (req.method === 'DELETE' && del) {
      containers.delete(del[1]);
      return send(204, '');
    }
    const wait = url.pathname.match(/^\/containers\/([^/]+)\/wait$/);
    if (req.method === 'POST' && wait) return send(200, { StatusCode: 0 });
    send(404, { message: `no route ${req.method} ${url.pathname}` });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    containers,
    close: () => new Promise((resolve) => server.close(() => { fs.rmSync(socketPath, { force: true }); resolve(); })),
  };
}
