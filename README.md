# Jonathan's Apps

Community app store for umbrelOS 2. Store id `jonbeckman`. The Umbrel UI shows it as **Jonathan's Apps App Store**.

Images are built from this repository and pulled from public GHCR packages. Base images are official ones, digest-pinned. Renovate opens pull requests for base-image and GitHub Action bumps and does not auto-merge them.

The default branch of this repository is `master`.

## Add the store

On the Umbrel: **App Store → ⋯ → Community App Stores → Add**, and paste:

```
https://github.com/jonbeckman/umbrel-apps
```

Open that store from the same menu and install an app the same way as an official one.

## Apps

| App | ID | Version | Port | What it does |
| --- | --- | --- | --- | --- |
| GitHub Runner | `jonbeckman-github-runner` | 0.1.1 | 3500 | Self-hosted Actions runners for private repositories. One fresh container per job, inside a Docker daemon private to the app. |
| Grafana Alloy | `jonbeckman-grafana-alloy` | 0.1.2 | 3501 | Host metrics, container metrics, container logs, runner `/metrics`, and an internal OTLP receiver, shipped to Grafana Cloud. |

Neither app publishes a host port. The setup pages are behind the Umbrel login (`PROXY_AUTH_ADD`).

### GitHub Runner

Labels are `self-hosted`, `umbrel` (or `umbrel-docker` for Docker-for-jobs), `Linux`, and `X64`.

The runner image starts from `ghcr.io/actions/actions-runner` and adds zstd, build-essential, `gh`, the Docker Compose plugin, Node 24.15.0, and Nub 0.9.6. `nubjs/setup-nub@v0.6.0` with `nub-version: 0.9.6` still runs. The image seeds `$RUNNER_TOOL_CACHE/nub/0.9.6/$RUNNER_ARCH` from the preinstalled copy when that directory is empty, which is the action's existing fast path.

Nub's content store is `npm_config_store_dir` plus `/v1`. Checked with Nub 0.9.6: `npm_config_store_dir=/tmp/nub-store-test nub store path` prints `/tmp/nub-store-test/v1`. The metadata cache is `NUB_CACHE_DIR` (`nub config get cache-dir`). Each repository gets its own directory on the Umbrel disk:

```
data/cache/<owner>__<repo>/
  nub-store/       npm_config_store_dir  (Nub uses nub-store/v1)
  nub-cache/       NUB_CACHE_DIR
  ms-playwright/   PLAYWRIGHT_BROWSERS_PATH
  e2e/             E2E_CACHE_DIR
  toolcache/       RUNNER_TOOL_CACHE
  xdg-data/        XDG_DATA_HOME
  xdg-cache/       XDG_CACHE_HOME
```

Repositories do not share that tree. It is deleted once a week, and only while no runner container is alive.

Images a job pulls through Docker for jobs stay in `data/dind`. That directory is the private daemon's `--data-root`, so they are still there for the next job. The weekly wipe does not remove them.

Workflow tweaks for jobs on this runner:

- `nubjs/setup-nub`: set `cache: false` and `package-manager-cache: false`. The action's cache input uploads the store to GitHub and downloads it again. Nub already reads the on-disk store.
- `actions/setup-node`: leave `cache` unset or `false` for the same reason.
- If the job wants Node 24.15.0, set `provision-node: false` on setup-nub. A different Node version is downloaded once into that repository's tool cache.
- Do not set `PLAYWRIGHT_BROWSERS_PATH=0`. The browser download then stays in `ms-playwright/`.
- Do not point `E2E_CACHE_DIR` at the checkout. The app sets an absolute directory, which replaces tester-army e2e's `cache.dir`.

Example:

```yaml
jobs:
  test:
    runs-on: [self-hosted, umbrel]
    steps:
      - uses: actions/checkout@v4
      - uses: nubjs/setup-nub@v0.6.0
        with:
          nub-version: 0.9.6
          cache: false
          package-manager-cache: false
          provision-node: false
```

Jobs that need a Docker daemon use `runs-on: [self-hosted, umbrel-docker]` and Docker for jobs, which stays off until you type `docker` on the setup page. The private daemon is privileged. A job with that socket can reach the host. Turn it on only when every workflow in the selected repositories is yours.

Fine-grained tokens are per resource owner. Save one whose resource owner is the **SolZeroAI** organization and one whose resource owner is the **jonbeckman** user. The first repository to add is `SolZeroAI/janus`.

Each token:

- Fine-grained (`github_pat_...`). Classic `ghp_` tokens are refused.
- Resource owner: `SolZeroAI` or `jonbeckman`, matching the name you type on the page.
- Repository access: only the private repositories this runner should serve.
- Repository permissions: **Administration: Read and write**, **Actions: Read-only**. Metadata is added on its own. Nothing else.
- For the organization token, approve it in the SolZeroAI org if GitHub asks.

Public repositories are refused. If a served repository becomes public, its runners are stopped. Jobs whose head repository is a fork, including `pull_request_target`, are left in GitHub's queue.

Parallel jobs default to 2 and cap at 4. Memory per job is half of the machine divided by the cap, at least 1 GB and at most 8 GB, with no extra swap. On this 8 GB NUC at the default cap that is 2 GB per job. CPU is shared by weight (`cpu_shares: 256` on the private daemon) with no hard quota.

The manager listens on port 3500 inside the Umbrel docker network. `/metrics` is readable there so Alloy can scrape `jonbeckman-github-runner_manager_1:3500`. The rest of the API answers only the app proxy, the bridge gateway, and loopback. Logs are JSON on stdout. The token file is `data/manager/state.json`, mode 0600. A runner container receives only its JIT config.

Before uninstalling: **Remove runners from GitHub** on the setup page, then revoke both tokens.

### Grafana Alloy

Official `grafana/alloy` v1.21.0, digest-pinned. Alloy's memory limit is 192 MB. The setup container is capped at 96 MB. `--disable-reporting` is set so Alloy does not phone home to Grafana's usage collector.

It collects:

- Host metrics from `prometheus.exporter.unix` with `/proc`, `/sys`, and `/` mounted read-only. Collectors are cpu, meminfo, loadavg, filesystem, diskstats, netdev, pressure, vmstat, stat, time, and uname, which covers `node_cpu_seconds_total` and the `node_memory_*` series on the dashboard.
- Container metrics from `prometheus.exporter.cadvisor`, relabeled down to CPU, memory, network, OOM, and `container_last_seen`. Container labels are limited to the compose project and service, so environment variables are not turned into metric labels.
- All container logs via `loki.source.docker`, labeled `umbrel_app` from the compose project (the Umbrel app id) and `container`.
- The runner manager's `/metrics`.
- OTLP from other apps on `4317` (gRPC) and `4318` (HTTP). Those ports are not published on the host. `exports.sh` sets `JONBECKMAN_GRAFANA_ALLOY_OTLP_GRPC` and `JONBECKMAN_GRAFANA_ALLOY_OTLP_HTTP`.

Alloy does not receive the host Docker socket. The setup container mounts it and exposes a proxy socket that forwards only `GET` and `HEAD`. A unix socket cannot be connected through a read-only file mount, so the host socket itself is not mounted `:ro`; the proxy is the read-only boundary.

On the setup page, paste values from the stack https://rubybandicoot3279.grafana.net (Grafana Cloud → the stack → Connections, US East):

- Prometheus remote_write URL and instance ID (username)
- Loki push URL and instance ID
- OTLP gateway URL and instance ID
- One access-policy token that can write metrics, logs, and traces

They are written to `data/alloy/config.alloy` as mode 0440, owned by uid 473 (the Alloy user). Restart the app after saving. Until credentials are saved, Alloy starts and does not remote-write.

A starter dashboard is `jonbeckman-grafana-alloy/dashboards/umbrel-host-runners.json`. Import it in Grafana and pick this stack's Prometheus and Loki datasources.

## Images

| Image | Built here | Base |
| --- | --- | --- |
| `ghcr.io/jonbeckman/github-runner-manager` | yes | `node:22-alpine` |
| `ghcr.io/jonbeckman/github-runner-image` | yes | `ghcr.io/actions/actions-runner` and `node:24.15.0-bookworm-slim` |
| `ghcr.io/jonbeckman/grafana-alloy-setup` | yes | `node:22-alpine` |
| `docker:29.9.1-dind` | no | Docker official |
| `grafana/alloy:v1.21.0` | no | Grafana official |

Built images are `linux/amd64` only. The NUC is x86_64, and the Nub archive pinned in the runner Dockerfile is `nub-linux-x64`.

Pull requests run the unit tests and build the three images without pushing them. A push to `master` that changes an image source pushes the images to GHCR and commits digest pins into the compose files (`chore: pin app image digests`). Until that commit lands, compose names the images by tag with a `# pinned-by-ci` marker. Umbrel should be updated after the pin commit, and the GHCR packages must be public or the pull is unauthorized.

The workflow tries to mark the three packages public. If it cannot, open each package under GitHub → Packages and set the visibility to public. The Umbrel has no registry credentials.

Base image digests in the Dockerfiles and compose files are pinned now. Our image digests are pinned by the workflow after the first green build on `master`.

## Updates

Umbrel offers an update when `version` in that app's `umbrel-app.yml` changes on `master`. A merge that does not change `version` does not update an install that is already there.

1. Merge the change.
2. If the change touches an image, wait for the pin commit on `master`.
3. Bump `version` and `releaseNotes` in `umbrel-app.yml` if the merge did not already. Keep the image tag in `docker-compose.yml` equal to that version when you want the next pin to match it.
4. On the Umbrel, open the app and choose **Update**.

Renovate (`renovate.json`) opens pull requests for Docker base images and GitHub Actions. Auto-merge is off. Review the digest, merge, and let the image workflow rebuild anything that `FROM`s that base.

## What this was checked against

- [getumbrel/umbrel-community-app-store](https://github.com/getumbrel/umbrel-community-app-store): `umbrel-app-store.yml` (`id`, `name`) and app directories prefixed with that id.
- umbrelOS manifest handling in `getumbrel/umbrel` (`schema.ts`, app install script): `manifestVersion` is a semantic version and must be less than or equal to the running umbrelOS (2.0.0 here, so `1.1` is fine). Updates copy `docker-compose.yml`, `exports.sh`, `hooks`, and then `umbrel-app.yml`. `app_proxy` uses `APP_HOST` of the form `<app-id>_<service>_1`.
- Nub 0.9.6 docs and the published `nub-linux-x64.tar.gz.sha256` (`77220dc6deb6ebbdb0a282c61b80a157e32016e088f3632d8fb4bf74a931e4ce`), confirmed by running the binary.
- `nubjs/setup-nub` `v0.6.0` `action.yml`: an exact nub version already at `$RUNNER_TOOL_CACHE/nub/<version>/$RUNNER_ARCH/bin/nub` is reused.
- tester-army e2e docs: replay files live under `.e2e/cache` or `E2E_CACHE_DIR`; browser binaries follow Playwright's `PLAYWRIGHT_BROWSERS_PATH`.

`zot24/umbrel-apps` has no license file. The runner follows that app's design (JIT containers, private repos, fork refusal, memory split, app_proxy setup page) and is an independent implementation. See `NOTICE`.

## Review of the zot24 runner

Read before this tree was written. Their repository has no `LICENSE` (the license API returns 404), so none of their source, tests, or HTML was copied.

What that code does that matters here:

- The setup page loads Google Fonts (`fonts.googleapis.com` and `fonts.gstatic.com`). Opening it contacts Google. This store's pages have no third-party assets and send a Content-Security-Policy. Scripts are files on the same origin (`script-src 'self'`). The policy does not allow inline scripts.
- Other outbound calls are GitHub's API, plus a redirect to fetch a job's log blob. The token is not sent to that blob host. This manager does not download job logs.
- Their client identified itself as `zot24-github-runner`. This one uses `jonbeckman-github-runner`.
- The private Docker daemon is privileged. That is required for `docker:dind` and it is the sharp edge of the app. Docker-for-jobs is off until the setup page is given the word `docker`. A job that holds that socket can control that daemon.
- They `docker exec` into the job container to read step logs. This manager does not.
- The page can show the last four characters of a token. The API does not return the token. Classic tokens are refused. A registration-token request is used only as a permission check and the body is discarded. JIT config is not written to the logs.
- Public repositories are refused, and runners for a repository that later becomes public are stopped. Fork jobs, including a missing head repository and `pull_request_target`, are skipped.
- The private network has inter-container communication off. The runner app does not mount the host Docker socket. `/metrics` is the only manager route a sibling container can call, and the port is not published on the host.

## Not checked on an Umbrel

This repository's tests do not start umbrelOS. Still unchecked on the NUC: installing the store, Umbrel login in front of the setup pages, a privileged `dind` job, whether `prometheus.exporter.cadvisor` returns useful numbers without a privileged Alloy container, whether Alloy accepts the unconfigured config and the OTLP receivers at stability `generally-available`, the real tester-army e2e binary honoring an absolute `E2E_CACHE_DIR`, GHCR packages actually being public, and Alloy staying under 192 MB resident and the setup container staying under 96 MB.
