import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSecrets, publicStatus, renderAlloy } from './render.mjs';

const secrets = {
  promUrl: 'https://prometheus-prod-00.grafana.net/api/prom/push',
  promUser: '123',
  lokiUrl: 'https://logs-prod-00.grafana.net/loki/api/v1/push',
  lokiUser: '456',
  otlpUrl: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp',
  otlpUser: '789',
  token: 'glc_exampletoken',
};

const CADVISOR_KEEP = 'container_(cpu_usage_seconds_total|memory_(working_set|rss|cache|swap)_bytes|spec_memory_limit_bytes|oom_events_total|network_(receive|transmit)_bytes_total|last_seen)';

test('unconfigured alloy config ships nothing and hides container env', () => {
  const text = renderAlloy(null);
  assert.match(text, /managed: unconfigured/);
  assert.equal(text.includes('password'), false);
  assert.match(text, /store_container_labels = false/);
  assert.match(text, /jonbeckman-github-runner_manager_1:3500/);
  assert.match(text, /forward_to = \[\]/);
  assert.match(text, /set_collectors = \["cpu", "meminfo", "loadavg", "filesystem", "diskstats", "netdev", "pressure", "vmstat", "stat", "time", "uname"\]/);
  assert.equal(text.includes('disable_collectors'), false);
  assert.equal(text.includes('external_labels'), false);
  assert.equal(text.includes('host = "umbrel"'), false);
  assert.match(text, /disabled_metrics = \["advtcp", "cpu_topology", "cpuset", "hugetlb", "memory_numa", "percpu", "referenced_memory", "resctrl", "sched", "tcp", "udp", "process", "disk", "diskIO"\]/);
  assert.match(text, /prometheus\.relabel "containers"/);
  assert.match(text, /forward_to = \[prometheus\.relabel\.containers\.receiver\]/);
  assert.match(text, new RegExp(`regex = "${CADVISOR_KEEP.replaceAll(/[()|]/g, '\\$&')}"`));
  const keep = new RegExp(`^(?:${CADVISOR_KEEP})$`);
  for (const name of [
    'container_cpu_usage_seconds_total',
    'container_memory_working_set_bytes',
    'container_memory_rss_bytes',
    'container_memory_cache_bytes',
    'container_memory_swap_bytes',
    'container_spec_memory_limit_bytes',
    'container_oom_events_total',
    'container_network_receive_bytes_total',
    'container_network_transmit_bytes_total',
    'container_last_seen',
  ]) {
    assert.match(name, keep);
  }
  for (const name of ['container_fs_usage_bytes', 'container_memory_failcnt', 'container_network_receive_packets_total', 'node_cpu_seconds_total']) {
    assert.equal(keep.test(name), false, name);
  }
});

test('configured config escapes secrets and opens OTLP only on the docker network', () => {
  const token = 'glc_"quoted"';
  const text = renderAlloy({ ...secrets, token });
  assert.match(text, /managed: configured/);
  assert.match(text, /0\.0\.0\.0:4317/);
  assert.match(text, /0\.0\.0\.0:4318/);
  assert.ok(text.includes(JSON.stringify(token)));
  assert.equal(text.includes('glc_"quoted"\n'), false);
  assert.throws(() => checkSecrets({ ...secrets, promUrl: 'http://example' }), /https/);
  assert.throws(() => checkSecrets({ ...secrets, token: 'has space' }), /Token/);
  assert.equal(JSON.stringify(publicStatus({ ...secrets, token })).includes('glc_'), false);
});

test('configured config adds host=umbrel on remote write and loki write only', () => {
  const text = renderAlloy(secrets);
  const label = 'external_labels = { host = "umbrel" }';
  const places = [];
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(label, from);
    if (at < 0) break;
    const headers = [...text.slice(0, at).matchAll(/^([a-z0-9_.]+ "[^"]+") \{$/gm)];
    places.push(headers.at(-1)?.[1]);
    from = at + label.length;
  }
  assert.deepEqual(places, ['prometheus.remote_write "grafana"', 'loki.write "grafana"']);
  assert.match(text, /labels = \{ job = "umbrel" \}/);
  assert.equal(text.includes('host.name'), false);
  const bare = renderAlloy(null);
  assert.equal(bare.includes(label), false);
  assert.equal(bare.includes('external_labels'), false);
});
