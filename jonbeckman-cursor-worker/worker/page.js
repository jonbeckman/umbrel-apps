// Password fields are cleared after a successful save. The notice has to say
// the key was saved, because a blank field otherwise looks like nothing was
// stored. The status poll updates #status and must not overwrite #notice.
const $ = (id) => document.getElementById(id);
let reposDirty = false;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-GHR-Request': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function del(path) {
  const res = await fetch(path, { method: 'DELETE', headers: { 'X-GHR-Request': '1' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function renderOwners(owners) {
  const box = $('owners');
  box.replaceChildren();
  for (const row of owners || []) {
    const line = document.createElement('div');
    const name = document.createElement('code');
    name.textContent = row.owner;
    const saved = row.token === 'token saved';
    line.append(name, document.createTextNode(saved ? ' token saved' : ' not set'));
    if (saved) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Remove';
      button.dataset.owner = row.owner;
      line.append(document.createTextNode(' '), button);
    }
    box.append(line);
  }
}

async function refresh() {
  const data = await api('/api/status');
  $('key-status').textContent = data.cursorKey === 'key saved' ? 'Key saved.' : 'Cursor API key is not set.';
  renderOwners(data.owners);
  if (!reposDirty) $('repos').value = (data.repos || []).join('\n');
  const worker = data.worker || {};
  const lines = [
    data.stateError || '',
    `Worker: ${worker.running ? 'running' : 'stopped'}`,
    `Connected: ${worker.connected ? 'yes' : 'no'}`,
    `Last error: ${worker.lastError || 'none'}`,
  ];
  if (worker.dirs && worker.dirs.length) lines.push(`Directories: ${worker.dirs.join(', ')}`);
  if (worker.skipped && worker.skipped.length) {
    lines.push('Skipped:');
    for (const row of worker.skipped) lines.push(`- ${row.repo}: ${row.error}`);
  }
  $('status').textContent = lines.filter(Boolean).join('\n');
}
// end refresh

function showNotice(text, isError) {
  $('notice').textContent = text;
  $('notice').className = isError ? 'err' : '';
}

$('repos').addEventListener('input', () => { reposDirty = true; });

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const owners = [
    { owner: 'SolZeroAI', token: $('token-sol').value },
    { owner: 'jonbeckman', token: $('token-jon').value },
  ];
  if ($('owner').value.trim() || $('token').value) {
    owners.push({ owner: $('owner').value.trim(), token: $('token').value });
  }
  try {
    await api('/api/save', {
      cursorApiKey: $('cursor').value,
      owners,
      repos: $('repos').value,
    });
    $('cursor').value = '';
    $('token-sol').value = '';
    $('token-jon').value = '';
    $('owner').value = '';
    $('token').value = '';
    reposDirty = false;
    showNotice('Saved. Key saved. The worker is restarting.', false);
    await refresh();
  } catch (e) {
    showNotice(e.message, true);
  }
});

$('owners').addEventListener('click', async (ev) => {
  const owner = ev.target?.dataset?.owner;
  if (!owner) return;
  try {
    await del(`/api/owners/${encodeURIComponent(owner)}`);
    showNotice('Token removed. The worker is restarting.', false);
    await refresh();
  } catch (e) {
    showNotice(e.message, true);
  }
});

refresh().catch((e) => showNotice(e.message, true));
setInterval(() => refresh().catch(() => {}), 5000);
