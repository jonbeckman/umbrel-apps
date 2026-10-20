import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startDockerReadProxy } from './docker-ro.mjs';

function once(server, socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/v1.41/containers/json', method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('docker proxy forwards GET and refuses POST', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dro-'));
  const upstreamPath = path.join(dir, 'up.sock');
  const listenPath = path.join(dir, 'ro.sock');
  const upstream = http.createServer((req, res) => {
    res.writeHead(req.method === 'GET' ? 200 : 500);
    res.end(req.method);
  });
  await new Promise((resolve) => upstream.listen(upstreamPath, resolve));
  const proxy = await startDockerReadProxy({ listenPath, upstreamPath });
  try {
    const got = await once(upstream, listenPath);
    assert.equal(got.status, 200);
    assert.equal(got.body, 'GET');
    const denied = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: listenPath, path: '/containers/create', method: 'POST', agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /not allowed/);
    for (const [p, headers] of [['/containers/abc/attach/ws?stream=1', { Connection: 'Upgrade', Upgrade: 'websocket' }], ['/containers/abc/attach', {}], ['/v1.41/containers/json', { Connection: 'Upgrade', Upgrade: 'tcp' }]]) {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ socketPath: listenPath, path: p, method: 'GET', headers, agent: false }, (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode));
        });
        req.on('upgrade', () => resolve(101));
        req.on('error', reject);
        req.end();
      });
      assert.equal(res, 403, p);
    }
  } finally {
    proxy.close();
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});
