#!/bin/sh
# Copy an existing Scrypted volume into this app once, then start the image.
# The source is whatever is mounted at /import (read-only). Nothing here
# writes to that directory. A second start sees scrypted.db and does no copy.
set -eu

volume="${SCRYPTED_VOLUME:-/server/volume}"
import_dir="${SCRYPTED_IMPORT:-/import}"

log() {
  echo "scrypted: $*"
}

same_directory() {
  [ -d "$1" ] && [ -d "$2" ] || return 1
  left=$(cd "$1" && pwd -P)
  right=$(cd "$2" && pwd -P)
  [ "$left" = "$right" ]
}

import_volume() {
  db="$volume/scrypted.db"
  if [ ! -d "$import_dir" ]; then
    log "no $import_dir mount; starting with this app's own volume"
    return 0
  fi
  if same_directory "$import_dir" "$volume"; then
    log "$import_dir is the app volume; import skipped"
    return 0
  fi
  if [ -f "$db/CURRENT" ]; then
    log "database already at $db; import skipped"
    return 0
  fi
  if [ ! -f "$import_dir/scrypted.db/CURRENT" ]; then
    log "$import_dir has no scrypted.db; import skipped"
    return 0
  fi

  mkdir -p "$volume"
  staging="$volume/.import-staging"
  rm -rf "$staging"
  mkdir -p "$staging"

  # Files other than the database can be recopied if this run is interrupted.
  # scrypted.db is copied aside and renamed into place last, so a partial copy
  # does not look like an installed database.
  for entry in "$import_dir"/* "$import_dir"/.[!.]* "$import_dir"/..?*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    if [ "$name" = "scrypted.db" ] || [ "$name" = ".import-staging" ]; then
      continue
    fi
    cp -a "$entry" "$volume/$name"
  done

  cp -a "$import_dir/scrypted.db" "$staging/scrypted.db"
  if [ ! -f "$staging/scrypted.db/CURRENT" ]; then
    echo "scrypted: copy of scrypted.db did not include CURRENT" >&2
    exit 1
  fi
  # rename(2) needs the directory writable so it can update "..". The source
  # mode is put back after the rename. This chmod is on the copy only.
  chmod u+w "$staging/scrypted.db"
  mv "$staging/scrypted.db" "$volume/scrypted.db"
  chmod --reference="$import_dir/scrypted.db" "$volume/scrypted.db"
  rmdir "$staging"
  log "imported $import_dir into $volume"
}

import_volume

# koush/scrypted:v0.148.0-noble-full config: ENTRYPOINT ["/init"],
# CMD ["/bin/sh", "-c", "ulimit -c 0; exec npm --prefix /server exec scrypted-serve"].
# Compose drops the image CMD when entrypoint is overridden, so the compose
# file sets command to that same argv. If it is missing, use it here too.
init="${SCRYPTED_INIT:-/init}"
if [ "$#" -eq 0 ]; then
  log "no command arguments; using the image CMD"
  set -- /bin/sh -c "ulimit -c 0; exec npm --prefix /server exec scrypted-serve"
fi

if [ "${SCRYPTED_IMPORT_ONLY:-}" = "1" ]; then
  if [ -n "${SCRYPTED_EXEC_LOG:-}" ]; then
    printf '%s\0' "$init" "$@" > "$SCRYPTED_EXEC_LOG"
  fi
  exit 0
fi

exec "$init" "$@"
