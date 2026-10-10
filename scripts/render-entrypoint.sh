#!/usr/bin/env bash
# The persistent disk is mounted as root. Cuttlely runs as the node user.
set -euo pipefail

DATA="${CUTTLELY_DATA_DIR:-/var/cuttlely}"
# App data is $DATA/data. An old $DATA/flowise stays put until an operator moves it.
# versions starts empty; the server runs git init on first use.
mkdir -p \
    "$DATA/data" \
    "$DATA/versions" \
    "$DATA/hermes" \
    "$DATA/storage" \
    "$DATA/etl" \
    "$DATA/logs" \
    "$DATA/harnesses"

if [ "$(id -u)" -eq 0 ]; then
    chown -R node:node "$DATA"
    if ! command -v setpriv >/dev/null 2>&1; then
        echo "setpriv is required to drop root before starting Cuttlely" >&2
        exit 1
    fi
    # setpriv keeps this environment. The image starts as root, so HOME would
    # stay /root and the node user cannot create files there.
    node_home="$(getent passwd node | cut -d: -f6)"
    if [ -z "$node_home" ] || [ ! -d "$node_home" ]; then
        echo "The node user has no home directory" >&2
        exit 1
    fi
    export HOME="$node_home"
    export USER=node
    export LOGNAME=node
    exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
