#!/usr/bin/env bash
# Build the compose image, start it, and wait until ping prints pong.
# From the repository root: bash scripts/docker-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose up --build -d

deadline=$((SECONDS + ${CUTTLELY_SMOKE_TIMEOUT:-300}))
while (( SECONDS < deadline )); do
        if out="$(docker compose exec -T cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping 2>/dev/null)"; then
        printf '%s\n' "$out"
        if [[ "$out" == *pong* ]]; then
            exit 0
        fi
    fi
    sleep 3
done

echo "ping did not return pong within ${CUTTLELY_SMOKE_TIMEOUT:-300}s" >&2
docker compose logs --tail=40 cuttlely >&2 || true
exit 1
