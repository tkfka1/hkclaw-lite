#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  exec sleep infinity
fi

case "$1" in
  sh|bash|/bin/sh|/bin/bash|sleep)
    exec "$@"
    ;;
esac

exec node /app/bin/hkclaw-lite.js "$@"
