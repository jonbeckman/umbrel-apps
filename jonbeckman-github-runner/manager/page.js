const $ = (id) => document.getElementById(id);
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
}
function showError(e) { $('banner').innerHTML = '<span class="err"></span>'; $('banner').firstChild.textContent = e.message; }
async function refresh() {
  const s = await api('/api/status');
  $('banner').textContent = s.installId ? `Install ${s.installId}. Labels: ${s.labels.join(', ')}.` : '';
  if (s.tickError) $('banner').textContent += ' ' + s.tickError;
  $('owners').innerHTML = s.owners.map((o) => `<div><code></code> ${o.login ? 'user ' : ''}<span></span> ${o.hint} ${o.expires || ''} <span class="err"></span> <button type="button" data-owner="${o.owner}">Remove</button></div>`).join('') || '<p class="muted">No tokens yet.</p>';
  [...$('owners').querySelectorAll('div')].forEach((row, i) => {
    const o = s.owners[i];
    row.querySelector('code').textContent = o.owner;
    row.querySelector('span').textContent = o.login || '';
    row.querySelector('.err').textContent = o.error || '';
  });
  $('repos').innerHTML = '<table><tr><th>Repo</th><th>Queued</th><th>Forks skipped</th><th></th></tr>' + s.repos.map((r) => `<tr><td><code></code></td><td>${r.queued || 0}${r.publicAt ? ' public' : ''}</td><td>${r.forks || 0}</td><td>${r.error || ''}</td></tr>`).join('') + '</table>';
  [...$('repos').querySelectorAll('code')].forEach((el, i) => { el.textContent = s.repos[i].name; });
  $('max').value = s.settings.maxRunners;
  $('paused').checked = s.settings.paused;
  $('docker').checked = s.settings.dockerForJobs;
  const runners = s.runners.map((r) => `${r.name} ${r.repo} ${r.job || '(waiting)'} mem=${r.mem ?? '—'}`).join('\n') || 'No runners.';
  const history = s.history.slice(0, 8).map((h) => `${h.finishedAt} ${h.repo} ${h.result} ${h.job || ''}`).join('\n');
  $('live').textContent = runners + (history ? '\n\nRecent\n' + history : '');
}
$('owners').addEventListener('click', async (ev) => {
  const owner = ev.target?.dataset?.owner;
  if (!owner) return;
  try { await del('/api/owners/' + encodeURIComponent(owner)); await refresh(); } catch (e) { showError(e); }
});
$('owner-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try { await api('/api/owners', { owner: $('owner').value, token: $('token').value }); $('token').value = ''; await refresh(); }
  catch (e) { showError(e); }
});
$('add-repo').onclick = async () => {
  try { await api('/api/repos', { repo: $('repo').value }); await refresh(); } catch (e) { showError(e); }
};
$('save-settings').onclick = async () => {
  try {
    await api('/api/settings', {
      maxRunners: Number($('max').value),
      paused: $('paused').checked,
      dockerForJobs: $('docker').checked,
      dockerConfirm: $('docker-confirm').value,
    });
    await refresh();
  } catch (e) { showError(e); }
};
$('remove-runners').onclick = async () => {
  try {
    const out = await api('/api/runners/remove', {});
    $('report').textContent = (out.report || []).join('\n');
    await refresh();
  } catch (e) { showError(e); }
};
refresh().catch(showError);
setInterval(() => refresh().catch(() => {}), 5000);
