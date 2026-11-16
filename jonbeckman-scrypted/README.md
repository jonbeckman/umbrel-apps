# Scrypted

Home video integration, with HomeKit on the host network. The image is `koush/scrypted:v0.148.0-noble-full`.

Denny's app (`denny-scrypted`) can stay installed. Its app proxy holds host port 11080. This app listens on **11081** (HTTP) and **11443** (HTTPS). The Umbrel tile is **3503**, behind the Umbrel login.

## Why the host network

Scrypted's HomeKit plugin advertises `_hap._tcp` with mDNS. On Umbrel's Docker bridge that advertisement never reaches the LAN, so Apple Home cannot find the bridge or the camera accessories. Scrypted's Docker install uses `network_mode: host` for this. This app does the same.

`SCRYPTED_DOCKER_AVAHI` is left unset. The upstream compose file says turning it on means stopping the host `avahi-daemon`, and that daemon is what publishes `umbrel.local`. The HomeKit plugin publishes with its own advertiser (ciao or bonjour) once it shares the host network.

## Ports and login

| Port | What it is |
| --- | --- |
| 3503 | Umbrel tile. umbreld proxies this to 127.0.0.1:11081 after the Umbrel login. |
| 11081 | Scrypted HTTP (`SCRYPTED_INSECURE_PORT`). Open on the host. Scrypted's own login applies. |
| 11443 | Scrypted HTTPS (`SCRYPTED_SECURE_PORT`). Open on the host. |
| 10081 | Scrypted's debug listener (`SCRYPTED_DEBUG_PORT`, the image default). |

`PROXY_AUTH_ADD` is `true`. The tile asks for the Umbrel login. The setting can be turned off later in the app's settings; the default is on.

3503 and 11081 are different on purpose. With an `app_proxy` block, umbreld binds `127.0.0.1` on the tile port. Scrypted binds its HTTP port on every address, including `127.0.0.1`. Using one number for both would make those two binds fight.

## How the container starts

The image's config is `ENTRYPOINT ["/init"]` and `CMD ["/bin/sh", "-c", "ulimit -c 0; exec npm --prefix /server exec scrypted-serve"]`. Compose drops that CMD when a service sets `entrypoint` and does not set `command`, and `/init` with no arguments does not start Scrypted. This app sets `command` to that same argv. `hooks/import-volume.sh` is the entrypoint; after the import it runs `/init` with those arguments. If the arguments are missing, the script uses the image CMD itself.

`NODE_OPTIONS` is `--dns-result-order=ipv4first --insecure-http-parser`. The image already set the DNS flag, and the compose value replaces it, so both are kept. `--insecure-http-parser` is what lets the Amcrest plugin accept the camera's digest-auth 401 replies and event stream on Scrypted v0.148.0.

The script is on disk at runtime because umbrelOS copies the app folder into the app data directory:

- Install: `packages/umbreld/source/modules/apps/apps.ts` `#install` runs `rsync --archive` from the app template into `${dataDirectory}/app-data/<id>`. `--archive` keeps the executable bit. `APP_DATA_DIR` is that directory (`legacy-compat/app-script`).
- Update: the same app script's `copy_app_files` whitelist is `docker-compose.yml`, templates, `exports.sh`, `torrc`, `hooks`, then `umbrel-app.yml`. A script left at the app root would stay at the old contents. `hooks/import-volume.sh` is copied again on update and mounted at `/import-volume.sh`.

## Import the existing database

The directory Denny mounts at `/server/volume` is the Files path `/Apps/denny-scrypted/data/scrypted`. It contains `scrypted.db` (LevelDB, with a `CURRENT` file) plus plugins and settings. Umbrel will not use a path under `/Apps` as a custom mount, so copy that directory to `/Home/scrypted-import-from-denny/scrypted` and mount the Home folder. This app mounts its own `data/scrypted` at `/server/volume`.

The copy is `hooks/import-volume.sh`, mounted at `/import-volume.sh`, and it runs before `/init`:

- No `/import` directory: Scrypted starts with this app's volume. Nothing is copied.
- `/import/scrypted.db/CURRENT` is missing: nothing is copied.
- This app's volume already has `scrypted.db/CURRENT`: nothing is copied, including on every later start.
- Otherwise the files are copied with `cp -a` (mode, owner, timestamps, symlinks). `scrypted.db` is renamed into place last. The source is only read. The container mount is read-only, and the script never writes there.

Install starts the app immediately, and that first start creates an empty `scrypted.db`. The import will not replace a database that is already there, so clear that empty one before the import start.

1. Install **Scrypted** from this store. Leave Denny's app installed.
2. Stop **Scrypted** (this app). Stop **denny-scrypted** as well, so LevelDB is not being written during the copy. Stopping Denny frees 11080; this app still uses 11081.
3. In Files, open `/Apps/jonbeckman-scrypted/data/scrypted`. Delete the contents of **this** directory (the empty database from step 1). Do not delete `/Apps/denny-scrypted/data/scrypted`. If Files cannot delete it, the first start owned it as root; remove `scrypted.db` from this app's data directory only.
4. Copy `/Apps/denny-scrypted/data/scrypted` to `/Home/scrypted-import-from-denny/scrypted`. Leave the original in place. Open this app's settings, then **Storage**, then **Add custom folder**.
   - Service: `server`
   - Path inside the app: `/import`
   - Read-only: on
   - Folder: `/Home/scrypted-import-from-denny/scrypted`
5. Start this app. The log line `scrypted: imported /import into /server/volume` means the copy ran. A later start logs `database already at /server/volume/scrypted.db; import skipped`.
6. Open the tile, sign in with the Umbrel login, then with the Scrypted user that was in the copied database. In Scrypted's settings, set **Scrypted Server Address** to this Umbrel's LAN address if the old value is a Docker bridge address.
7. Confirm the cameras. In Apple Home, the bridge and the camera accessories should browse on the LAN. Pairing keys are in the copied volume, so existing homes should keep the accessories. Use **Reset Pairing** on a camera only if that home still cannot find it.
8. The custom folder can stay or be removed. Removing it does not delete the copy in this app, or the folder under `/Home`. Uninstall `denny-scrypted` only after the new app is the one you use. Uninstalling Denny deletes `/Apps/denny-scrypted`, which is the original, not this app's copy.

The script refuses to copy when `/import` and the volume are the same directory. It does not delete files that are only in the source, and it does not delete files that are only in the new volume.

## Data from v0.122.0

Denny's image is `koush/scrypted:v0.122.0-jammy-full`. This app is `v0.148.0-noble-full` (Ubuntu Noble, newer than Jammy). Scrypted's own migration doc says a copy of the `volume` directory is the database move, including onto another install. There is no separate migration step between those two versions in that doc. Plugins and the LevelDB directory are inside the volume, so they come across with the copy.

What can still need a look after the first start:

- **Scrypted Server Address** may still be an address from the bridge network. Set it to the Umbrel's LAN address so HomeKit advertisements use an address Apple Home can reach.
- Python plugins keep working through the image's Python 3, 3.9, and 3.12. The image sets `SCRYPTED_PYTHON_PATH`, `SCRYPTED_PYTHON39_PATH`, and `SCRYPTED_PYTHON312_PATH`.
- A copy taken while Denny's container is running can be a torn LevelDB. Stop that app first.

## What this does not turn on

No GPU device (`/dev/dri`), USB device, or Coral device is passed through. No NVR disk is mounted. `SCRYPTED_DOCKER_AVAHI` is not set. Watchtower is not included; image updates are Renovate pull requests against the digest pin.
