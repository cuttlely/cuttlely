#!/usr/bin/env bash
# Exercise the packaged startup command, including the pre-server runtime import.
set -euo pipefail

image="${1:?Pass the locally built Cuttlely image tag}"
fixture="cuttlely-storage-$(openssl rand -hex 8)"
database="$fixture-db"
web="$fixture-web"
export POSTGRES_PASSWORD DATABASE_PASSWORD CUTTLELY_SECRETKEY_OVERWRITE
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
DATABASE_PASSWORD="$POSTGRES_PASSWORD"
CUTTLELY_SECRETKEY_OVERWRITE="$(openssl rand -hex 32)"

cleanup() {
    docker rm -fv "$web" "$database" >/dev/null 2>&1 || true
    docker network rm "$fixture" >/dev/null 2>&1 || true
}
docker network create --internal "$fixture" >/dev/null
trap cleanup EXIT
docker run -d --name "$database" --network "$fixture" --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_DB=cuttlely -e POSTGRES_PASSWORD postgres:16-alpine >/dev/null

wait_for() {
    local deadline=$((SECONDS + 180))
    until "$@" >/dev/null 2>&1; do
        if (( SECONDS >= deadline )); then
            echo "Timed out waiting for $1 $2 $3" >&2
            return 1
        fi
        sleep 2
    done
}
wait_for docker exec "$database" pg_isready -h 127.0.0.1 -U postgres -d cuttlely

start_web() {
    docker run -d --name "$web" --network "$fixture" --user 1000870001:0 --cap-drop ALL \
        --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,mode=1777 \
        --tmpfs /var/cuttlely:rw,mode=0770,gid=0 -e HOME=/root -e DATABASE_TYPE=postgres \
        -e DATABASE_HOST="$database" -e DATABASE_PORT=5432 -e DATABASE_NAME=cuttlely -e DATABASE_USER=postgres \
        -e DATABASE_PASSWORD -e CUTTLELY_SECRETKEY_OVERWRITE -e CUTTLELY_APP_DATABASE_STORES=1 \
        -e CUTTLELY_ANALYST=off -e CUTTLELY_LOCAL_USERS=true "$image" >/dev/null
    wait_for docker exec "$web" curl -fsS --max-time 3 http://127.0.0.1:43117/api/v1/ping
    local phase
    phase="$(docker exec "$database" psql -XAt -U postgres -d cuttlely -c "SELECT state->>'phase' FROM cuttlely_storage.upgrade WHERE id=1")"
    if [[ "$phase" != postgres ]]; then
        echo "Expected PostgreSQL storage to be active before accepting messages" >&2
        return 1
    fi
}

check_runtime() {
    docker exec -i -e HOME=/var/cuttlely/home -e CUTTLELY_DATA_DIR=/var/cuttlely -e HERMES_HOME=/var/cuttlely/hermes \
        -w /usr/src/cuttlely/hermes "$web" .venv/bin/python -B - "$1" <<'PY'
import sys
from pathlib import Path
from gateway.config import GatewayConfig
from gateway.session import SessionStore
from hermes_cli.config import save_env_value
from hermes_state import SessionDB

home = Path("/var/cuttlely/hermes")
db = SessionDB(home / "state.db")
session = "container-replacement"
if sys.argv[1] == "write":
    db.create_session(session, "cli")
    gateway = SessionStore(home / "sessions", GatewayConfig())
    gateway._db = db
    gateway.append_to_transcript(session, {"role": "assistant", "content": "saved before replacement"})
    save_env_value("RECOVERY_TEST_SETTING", "saved")
assert any(row["content"] == "saved before replacement" for row in db.get_messages(session)), "missing gateway message"
assert "RECOVERY_TEST_SETTING=saved" in (home / ".env").read_text().splitlines(), "missing runtime setting"
PY
}

start_web
check_runtime write
docker rm -fv "$web" >/dev/null
start_web
check_runtime read
echo "The replacement container recovered the gateway message and setting."
