#!/usr/bin/env bash
# Linux-only optional signed fixture. All page traffic terminates on the new namespace's loopback.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
unshare --user --map-current-user --mount --pid --fork --kill-child --mount-proc --net --ipc --keep-caps bash -se -- "$root" "$fixture" <<'INNER'
set -euo pipefail
root=$1
fixture=$2
mount --make-rprivate /
ip link set lo up
ip address add 11.111.32.2/32 dev lo
echo 0 > /proc/sys/net/ipv4/ip_unprivileged_port_start
printf '127.0.0.1 localhost\n::1 localhost\n11.111.32.2 catalog.example.invalid\n' > "$fixture/hosts"
mount --bind "$fixture/hosts" /etc/hosts
mount -o remount,bind,ro /etc/hosts
export TMPDIR=$fixture CUTTLELY_TEST_STATIC_PAGE_REQUIRED=1
exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all node --test "$root/scripts/kraken-static-page.test.mjs"
INNER
