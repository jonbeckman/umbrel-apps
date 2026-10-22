import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
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

test('a streaming upstream is closed within 200ms of the client disconnecting', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dro-'));
  const upstreamPath = path.join(dir, 'up.sock');
  const listenPath = path.join(dir, 'ro.sock');
  let upstreamSocket;
  const upstream = net.createServer((sock) => {
    upstreamSocket = sock;
    let started = false;
    let timer;
    sock.on('data', () => {
      if (started) return;
      started = true;
      sock.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
      timer = setInterval(() => {
        if (sock.destroyed) return clearInterval(timer);
        sock.write('5\r\nhello\r\n');
      }, 20);
    });
    sock.on('close', () => { if (timer) clearInterval(timer); });
    sock.on('error', () => { if (timer) clearInterval(timer); });
  });
  await new Promise((resolve) => upstream.listen(upstreamPath, resolve));
  const proxy = await startDockerReadProxy({ listenPath, upstreamPath });
  const client = net.connect(listenPath);
  client.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    let received = Buffer.alloc(0);
    client.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    client.write('GET /v1.41/containers/json HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive\r\n\r\n');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upstream did not stream')), 1000);
      const poll = setInterval(() => {
        if (!received.includes('hello')) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }, 10);
    });
    assert.ok(upstreamSocket && !upstreamSocket.destroyed);
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upstream socket stayed open')), 1000);
      upstreamSocket.once('close', () => {
        clearTimeout(timer);
        resolve(Date.now());
      });
    });
    const start = Date.now();
    client.end();
    const ended = await closed;
    const elapsed = ended - start;
    assert.ok(elapsed < 200, `upstream closed after ${elapsed}ms`);
  } finally {
    client.destroy();
    upstreamSocket?.destroy();
    proxy.close();
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('forwarded head is Connection: close and keeps buffered body bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dro-'));
  const upstreamPath = path.join(dir, 'up.sock');
  const listenPath = path.join(dir, 'ro.sock');
  let raw = Buffer.alloc(0);
  const upstream = net.createServer((sock) => {
    sock.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      if (raw.includes('\r\n\r\n') && raw.subarray(raw.indexOf('\r\n\r\n') + 4).length >= 4) {
        sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((resolve) => upstream.listen(upstreamPath, resolve));
  const proxy = await startDockerReadProxy({ listenPath, upstreamPath });
  const client = net.connect(listenPath);
  client.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.end('GET /v1.41/containers/json HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive\r\nConnection: x-extra\r\nContent-Length: 4\r\n\r\nping');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('upstream did not receive the request'));
      }, 1000);
      const poll = setInterval(() => {
        if (!raw.includes('\r\n\r\n') || !raw.subarray(raw.indexOf('\r\n\r\n') + 4).includes('ping')) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }, 10);
    });
    const text = raw.toString('latin1');
    const head = text.slice(0, text.indexOf('\r\n\r\n'));
    const connections = head.split('\r\n').filter((line) => /^connection\s*:/i.test(line));
    assert.deepEqual(connections, ['Connection: close']);
    assert.match(head, /^GET \/v1\.41\/containers\/json HTTP\/1\.1/);
    assert.match(head, /Host: docker/);
    assert.equal(text.slice(text.indexOf('\r\n\r\n') + 4, text.indexOf('\r\n\r\n') + 8), 'ping');
  } finally {
    client.destroy();
    proxy.close();
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});
