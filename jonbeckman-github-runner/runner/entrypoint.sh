#!/bin/bash
# Seed the persistent per-repo tool cache so nubjs/setup-nub can reuse the
# image's nub 0.9.6 instead of downloading it. The action looks up
# $RUNNER_TOOL_CACHE/nub/<version>/$RUNNER_ARCH/bin/nub. RUNNER_ARCH is set
# by the runner for the job; on this image it matches uname.
set -euo pipefail
if [[ -n "${RUNNER_TOOL_CACHE:-}" && -x /opt/nub/bin/nub ]]; then
  case "$(uname -m)" in
    aarch64|arm64) arch=ARM64 ;;
    *) arch=X64 ;;
  esac
  dest="${RUNNER_TOOL_CACHE}/nub/0.9.6/${arch}"
  if [[ ! -x "${dest}/bin/nub" ]]; then
    mkdir -p "${dest}"
    cp -a /opt/nub/. "${dest}/"
  fi
fi
exec /home/runner/run.sh "$@"
