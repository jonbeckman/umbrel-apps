// River config for Grafana Alloy. Secrets are written only into the
// configured file, which the setup server stores mode 0440.

const DOCKER = 'unix:///ro-docker/docker.sock';
const RUNNER = 'jonbeckman-github-runner_manager_1:3500';

export function riverString(value) {
  const text = String(value);
  if (!/^[\u0020-\u007e]+$/.test(text)) throw new Error('Value contains a character River will not quote safely.');
  return JSON.stringify(text);
}

export function checkSecrets(input) {
  const need = ['promUrl', 'promUser', 'lokiUrl', 'lokiUser', 'otlpUrl', 'otlpUser', 'token'];
  const out = {};
  for (const key of need) {
    const value = String(input?.[key] ?? '').trim();
    if (!value) throw new Error(`${key} is required.`);
    out[key] = value;
  }
  for (const key of ['promUrl', 'lokiUrl', 'otlpUrl']) {
    let url;
    try { url = new URL(out[key]); } catch { throw new Error(`${key} must be an https URL.`); }
    if (url.protocol !== 'https:') throw new Error(`${key} must be an https URL.`);
    if (url.username || url.password) throw new Error(`${key} must not include a username or password.`);
  }
  for (const key of ['promUser', 'lokiUser', 'otlpUser']) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(out[key])) throw new Error(`${key} looks wrong.`);
  }
  if (/\s/.test(out.token) || out.token.length < 8 || out.token.length > 512) throw new Error('Token looks wrong.');
  return out;
}

function collectors() {
  return `
prometheus.exporter.unix "host" {
  procfs_path = "/host/proc"
  sysfs_path = "/sys"
  rootfs_path = "/host/root"
  set_collectors = ["cpu", "meminfo", "loadavg", "filesystem", "diskstats", "netdev", "pressure", "vmstat", "stat", "time", "uname"]
}

prometheus.exporter.cadvisor "containers" {
  docker_host = ${riverString(DOCKER)}
  docker_only = true
  store_container_labels = false
  allowlisted_container_labels = ["com.docker.compose.project", "com.docker.compose.service"]
  storage_duration = "1m"
  disabled_metrics = ["advtcp", "cpu_topology", "cpuset", "hugetlb", "memory_numa", "percpu", "referenced_memory", "resctrl", "sched", "tcp", "udp", "process", "disk", "diskIO"]
}

prometheus.scrape "host" {
  targets = prometheus.exporter.unix.host.targets
  scrape_interval = "60s"
  forward_to = FORWARD
}

prometheus.relabel "containers" {
  forward_to = FORWARD
  rule {
    source_labels = ["__name__"]
    regex = "container_(cpu_usage_seconds_total|memory_(working_set|rss|cache|swap)_bytes|spec_memory_limit_bytes|oom_events_total|network_(receive|transmit)_bytes_total|last_seen)"
    action = "keep"
  }
}

prometheus.scrape "containers" {
  targets = prometheus.exporter.cadvisor.containers.targets
  scrape_interval = "60s"
  forward_to = [prometheus.relabel.containers.receiver]
}

prometheus.scrape "runner" {
  targets = [{
    __address__ = ${riverString(RUNNER)},
    job = "jonbeckman-github-runner",
  }]
  metrics_path = "/metrics"
  scrape_interval = "30s"
  forward_to = FORWARD
}
`.trim();
}

export function renderAlloy(secrets) {
  if (!secrets) {
    return `// managed: unconfigured\n// Save Grafana Cloud credentials on the setup page, then restart this app.\n\n${collectors().replaceAll('FORWARD', '[]')}\n`;
  }
  const s = checkSecrets(secrets);
  const ship = `
prometheus.remote_write "grafana" {
  endpoint {
    url = ${riverString(s.promUrl)}
    basic_auth {
      username = ${riverString(s.promUser)}
      password = ${riverString(s.token)}
    }
  }
}

discovery.docker "containers" {
  host = ${riverString(DOCKER)}
}

discovery.relabel "umbrel" {
  targets = discovery.docker.containers.targets
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]
    target_label = "umbrel_app"
  }
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex = "/(.*)"
    target_label = "container"
  }
}

loki.source.docker "containers" {
  host = ${riverString(DOCKER)}
  targets = discovery.relabel.umbrel.output
  labels = { job = "umbrel" }
  forward_to = [loki.write.grafana.receiver]
}

loki.write "grafana" {
  endpoint {
    url = ${riverString(s.lokiUrl)}
    basic_auth {
      username = ${riverString(s.lokiUser)}
      password = ${riverString(s.token)}
    }
  }
}

otelcol.auth.basic "grafana" {
  username = ${riverString(s.otlpUser)}
  password = ${riverString(s.token)}
}

otelcol.exporter.otlphttp "grafana" {
  client {
    endpoint = ${riverString(s.otlpUrl)}
    auth = otelcol.auth.basic.grafana.handler
  }
}

otelcol.receiver.otlp "apps" {
  grpc { endpoint = "0.0.0.0:4317" }
  http { endpoint = "0.0.0.0:4318" }
  output {
    metrics = [otelcol.exporter.otlphttp.grafana.input]
    logs = [otelcol.exporter.otlphttp.grafana.input]
    traces = [otelcol.exporter.otlphttp.grafana.input]
  }
}
`;
  return `// managed: configured\n\n${collectors().replaceAll('FORWARD', '[prometheus.remote_write.grafana.receiver]')}\n${ship}`;
}

export function publicStatus(secrets) {
  if (!secrets) return { configured: false, tokenSet: false };
  return {
    configured: true,
    tokenSet: true,
    promUrl: secrets.promUrl,
    promUser: secrets.promUser,
    lokiUrl: secrets.lokiUrl,
    lokiUser: secrets.lokiUser,
    otlpUrl: secrets.otlpUrl,
    otlpUser: secrets.otlpUser,
  };
}
