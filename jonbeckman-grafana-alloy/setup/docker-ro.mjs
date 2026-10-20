// Read-only Docker API proxy. Alloy never sees the host socket.
// GET and HEAD are forwarded. Every other method is refused, so a
// component cannot create, start, kill, or exec containers.
import net from 'node:net';
import { chmod, unlink } from 'node:fs/promises';

export function startDockerReadProxy({ listenPath, upstreamPath }) {
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let decided = false;
    const fail = () => { client.destroy(); };
    const onData = (chunk) => {
      if (decided) return;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (buf.length > 64 * 1024) fail();
        return;
      }
      decided = true;
      client.off('data', onData);
      const head = buf.subarray(0, idx).toString('latin1');
      const method = head.split(' ')[0];
      if (method !== 'GET' && method !== 'HEAD') {
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 19\r\nConnection: close\r\n\r\nmethod not allowed\n');
        return;
      }
      // Forward this one request. Further client bytes would be another
      // request on a keep-alive connection, so they close the proxy
      // instead of reaching the daemon.
      const declared = Number(head.match(/^content-length:\s*(\d+)/im)?.[1] || 0);
      const headerEnd = idx + 4;
      let forwarded = buf.length - headerEnd;
      const upstream = net.connect(upstreamPath);
      const closeBoth = () => { client.destroy(); upstream.destroy(); };
      upstream.on('error', closeBoth);
      client.on('error', closeBoth);
      const stopExtra = () => { client.destroy(); upstream.destroy(); };
      const onMore = (chunk) => {
        const room = declared - forwarded;
        if (room <= 0) return stopExtra();
        const take = chunk.subarray(0, room);
        forwarded += take.length;
        upstream.write(take);
        if (chunk.length > room) stopExtra();
      };
      upstream.on('connect', () => {
        upstream.write(buf);
        upstream.pipe(client);
        client.on('data', forwarded >= declared ? stopExtra : onMore);
      });
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  return (async () => {
    await unlink(listenPath).catch(() => {});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPath, resolve);
    });
    await chmod(listenPath, 0o666);
    return server;
  })();
}
