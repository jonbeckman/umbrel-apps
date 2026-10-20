import http from 'node:http';

export async function createFakeGitHub() {
  const repos = new Map();
  const runs = [];
  const jitCalls = [];
  let runnerSeq = 1;

  function repoOf(owner, name) {
    const key = `${owner}/${name}`;
    if (!repos.has(key)) repos.set(key, { private: true, full_name: key });
    return repos.get(key);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'github-authentication-token-expiration': '2099-01-01T00:00:00Z', ...extra });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/user') return send(200, { login: 'jonbeckman' });
    if (req.method === 'GET' && (parts[0] === 'orgs' || parts[0] === 'users') && parts.length === 2) return send(200, { login: parts[1] });
    if (parts[0] === 'repos' && parts.length >= 3) {
      const owner = parts[1];
      const name = parts[2];
      const repo = repoOf(owner, name);
      const rest = parts.slice(3).join('/');
      if (req.method === 'GET' && !rest) return send(200, { private: repo.private, full_name: repo.full_name, id: 1 });
      if (req.method === 'POST' && rest === 'actions/runners/registration-token') return send(201, { token: 'registration-discarded', expires_at: '2099-01-01T00:00:00Z' });
      if (req.method === 'GET' && rest === 'actions/runs') {
        const status = url.searchParams.get('status');
        const workflow_runs = runs.filter((run) => run.repository.full_name === repo.full_name && (!status || run.status === status));
        return send(200, { workflow_runs });
      }
      const jobs = rest.match(/^actions\/runs\/(\d+)\/jobs$/);
      if (req.method === 'GET' && jobs) {
        const run = runs.find((r) => String(r.id) === jobs[1]);
        return send(200, { jobs: run?.jobs || [] });
      }
      if (req.method === 'POST' && rest === 'actions/runners/generate-jitconfig') {
        const id = runnerSeq++;
        jitCalls.push({ repo: repo.full_name, authorization: req.headers.authorization || '' });
        return send(201, { encoded_jit_config: `jit-${id}`, runner: { id } });
      }
      if (req.method === 'DELETE' && rest.startsWith('actions/runners/')) return send(204);
      if (req.method === 'GET' && rest === 'actions/runners') return send(200, { runners: [] });
    }
    send(404, { message: `no route ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    repoOf,
    runs,
    jitCalls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
