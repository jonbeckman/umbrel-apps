# qbitwebui

A web UI for qBittorrent's WebUI API. The image is `ghcr.io/mkbula/qbitwebui:2.45.0`, the same digest as `latest` (`sha256:16902a917228443595d5faf5953d38e8a635d57b6054dbd7dbd86d49d4d6c782`).

The process listens on **3000** and logs `Server running on port 3000`. The Umbrel tile is **3504**, behind the Umbrel login. 3000 is not published on the host.

## qBittorrent

This app depends on the official `qbittorrent` app. Both containers are on `umbrel_main_network`.

Add an instance in qbitwebui:

| Field | Value |
| --- | --- |
| URL | `http://qbittorrent_server_1:8080` |
| Username | `admin` |
| Password | `adminadmin` |

`qbittorrent_server_1` is the container name umbrelOS forces (`<app-id>_<service>_1`). 8080 is qBittorrent's WebUI port inside that container. The Umbrel tile for qBittorrent is host port 8094, which is the login proxy, not the process.

`extra_hosts` sets `host.docker.internal` to `host-gateway`, so `http://host.docker.internal:8094` reaches that tile from this container. The container URL above does not go through the tile. qBittorrent's post-start hook whitelists `10.21.0.0/16`, which is the Umbrel Docker network, so **Skip authentication** works for `http://qbittorrent_server_1:8080`.

`admin` / `adminadmin` is the qBittorrent WebUI login the official app writes when no password has been set yet. If that password was changed, use the new one. qbitwebui itself has no default account. The first person to register is the admin. The manifest leaves `defaultUsername` and `defaultPassword` empty for that reason.

## ENCRYPTION_KEY

qbitwebui encrypts saved instance credentials with `ENCRYPTION_KEY` and refuses to start when that variable is missing or shorter than 32 characters (`src/server/utils/crypto.ts`). The salt file is `/data/.salt`. Changing the key later cannot decrypt credentials already stored.

Compose sets `ENCRYPTION_KEY` to `${APP_SEED}`. umbreld exports `APP_SEED` before it runs Docker Compose (`source_app` in `packages/umbreld/source/modules/apps/legacy-compat/app-script`):

```
APP_SEED=$(derive_entropy "app-${app}-seed")
```

`derive_entropy` is HMAC-SHA256 of that identifier with the Umbrel seed file. For this app the identifier is `app-jonbeckman-qbitwebui-seed`. The digest is 64 hex characters. It is the same on every start of this app on this Umbrel, and it is not written in the repository.

## Downloads

`DOWNLOADS_PATH=/downloads`. The bind is:

```
${UMBREL_ROOT}/data/storage/downloads:/downloads:ro
```

That is the volume in `getumbrel/umbrel-apps` `qbittorrent/docker-compose.yml`, with `:ro` added. The manifest declares the same slot:

- `permissions: [STORAGE_DOWNLOADS]`
- `folderAccess` id `umbrel-downloads`, service `web`, target `/downloads`, `readOnly: true`

umbrelOS 2 rewrites a compose source of `/data/storage/downloads` to `/home/Downloads` (`patchComposeFile`) and turns a mount of `/Home/Downloads` into the `umbrel-downloads` slot (`getFolderAccessSlots` in `packages/umbreld/source/modules/apps/app.ts`). The slot's saved source replaces the bind. When that source is `/External/hudson/downloads`, that directory is what is mounted read-only at `/downloads`. Until the slot is changed, the source is `/Home/Downloads`. The selection is stored on this app, so point this app's Downloads slot at the same folder the qBittorrent app is using.

qbitwebui's own database is `${APP_DATA_DIR}/data` mounted at `/data` (`qbitwebui.db` and `.salt`). The image already sets `DATABASE_PATH` and `SALT_PATH` to those files.
