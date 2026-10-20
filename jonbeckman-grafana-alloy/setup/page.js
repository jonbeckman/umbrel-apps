const state = document.getElementById('state');
async function refresh() {
  const res = await fetch('/api/status');
  const data = await res.json();
  state.textContent = data.configured
    ? `Credentials saved for Prometheus user ${data.promUser}. Restart the app to reload Alloy.`
    : 'Not configured yet. Alloy is collecting nothing for Grafana Cloud.';
  if (data.configured) {
    for (const key of ['promUrl', 'promUser', 'lokiUrl', 'lokiUser', 'otlpUrl', 'otlpUser']) {
      const input = document.querySelector(`[name="${key}"]`);
      if (input && data[key]) input.value = data[key];
    }
  }
}
document.getElementById('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  const res = await fetch('/api/secrets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GHR-Request': '1' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  state.textContent = res.ok ? 'Saved. Restart the app from the Umbrel UI.' : data.error;
  state.className = res.ok ? '' : 'err';
});
refresh().catch((e) => { state.textContent = e.message; });
