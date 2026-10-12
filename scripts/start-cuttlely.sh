#!/usr/bin/env bash
# Start Cuttlely and the vendored Hermes runtime as one server.
# Hermes binds 127.0.0.1 only.
# Harness jobs default to an in-process SQLite queue (CUTTLELY_HARNESS_QUEUE=inline).
# CUTTLELY_HARNESS_QUEUE=external runs them in packages/harness/worker.mjs instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Restart in place. When an owner selects Restart in Server settings, the server exits with 75. This outer copy
# keeps the environment it was started with and runs a fresh inner copy each time, so saved settings apply.
# CUTTLELY_SUPERVISED=1 tells the server that restart in place is available.
if [[ -z "${CUTTLELY_START_INNER:-}" ]]; then
    export CUTTLELY_SUPERVISED=1
    inner_pid=""
    stopping=0
    forward_stop() {
        stopping=1
        if [[ -n "$inner_pid" ]]; then
            kill -TERM "$inner_pid" 2>/dev/null || true
        fi
    }
    trap forward_stop TERM INT
    while true; do
        CUTTLELY_START_INNER=1 bash "$ROOT/scripts/start-cuttlely.sh" "$@" &
        inner_pid=$!
        status=0
        wait "$inner_pid" || status=$?
        # A signal ends wait early. Wait again for the real exit status.
        while kill -0 "$inner_pid" 2>/dev/null; do
            status=0
            wait "$inner_pid" || status=$?
        done
        inner_pid=""
        # 76: the server could not get ready with changed server settings. Start it again so safe boot can count the
        # failed start; after two, it puts back the last settings that worked. It never loops: with the settings that
        # last worked, the server does not exit with 76.
        if [[ "$stopping" -eq 1 || ( "$status" -ne 75 && "$status" -ne 76 ) ]]; then
            exit "$status"
        fi
        if [[ "$status" -eq 76 ]]; then
            echo "Cuttlely could not start with the saved server settings. Starting again (safe boot puts back the last settings that worked after two tries)."
        else
            echo "Restarting Cuttlely to apply server settings."
        fi
    done
fi

DATA="${CUTTLELY_DATA_DIR:-$ROOT/.cuttlely}"
export CUTTLELY_DATA_DIR="$DATA"
export CUTTLELY_HERMES_HOME="${CUTTLELY_HERMES_HOME:-$DATA/hermes}"
export HERMES_HOME="$CUTTLELY_HERMES_HOME"
export PORT="${PORT:-43117}"
export API_SERVER_ENABLED=true
export API_SERVER_HOST=127.0.0.1
export API_SERVER_PORT="${HERMES_API_PORT:-8642}"
export HERMES_API_URL="http://127.0.0.1:${API_SERVER_PORT}"

# Server settings saved from Admin, Server settings (CUTTLELY_DATA_DIR/settings/server.json). The host wins: names
# set here or in packages/server/.env are recorded first, then the file fills in the rest, then the defaults below.
# Values go from the helper straight into this environment through a pipe, never to a file or the log.
host_workos_key="${WORKOS_API_KEY:-}"
SETTINGS_ENV_CLI="$ROOT/packages/server/dist/settings/env-cli.js"
if [[ -f "$SETTINGS_ENV_CLI" ]]; then
    while IFS= read -r -d '' pair; do
        if [[ "${pair%%=*}" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
            export -- "$pair"
        fi
    done < <(node "$SETTINGS_ENV_CLI" start || true)
fi

# A local install gets the local account and its password form by default, and so does Docker
# (CUTTLELY_INSTALL=docker, set by compose). Render, WorkOS on a source install, or a CUTTLELY_LOCAL_ADMIN
# value (here or in packages/server/.env) decides for itself. Blank counts as not set, like compose passes it.
# A default filled in here is listed in CUTTLELY_SETTINGS_SCRIPT_DEFAULTS, so a value saved in Server settings still wins.
script_defaults=()
if [[ -z "${CUTTLELY_LOCAL_ADMIN:-}" && -z "${RENDER:-}" ]] &&
    ! grep -Eqs '^[[:space:]]*CUTTLELY_LOCAL_ADMIN=' "$ROOT/packages/server/.env"; then
    if [[ "${CUTTLELY_INSTALL:-}" == "docker" ]] ||
        { [[ -z "$host_workos_key" ]] && ! grep -Eqs '^[[:space:]]*WORKOS_API_KEY=' "$ROOT/packages/server/.env"; }; then
        export CUTTLELY_LOCAL_ADMIN=true
        script_defaults+=(CUTTLELY_LOCAL_ADMIN)
    fi
fi
export CUTTLELY_SETTINGS_SCRIPT_DEFAULTS="${script_defaults[*]:-}"

if [[ "$API_SERVER_HOST" != "127.0.0.1" ]]; then
    echo "Hermes must bind 127.0.0.1" >&2
    exit 1
fi

# packages/server/bin/run is tracked in git, so check what it loads instead.
missing=()
[[ -d "$ROOT/node_modules/@oclif/core" ]] || missing+=("node_modules/@oclif/core (dependencies are not installed)")
[[ -d "$ROOT/packages/server/dist/commands" ]] || missing+=("packages/server/dist/commands (the server is not built)")
[[ -f "$ROOT/packages/ui/build/index.html" ]] || missing+=("packages/ui/build/index.html (the UI is not built)")
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Cuttlely is not ready to start. Missing:" >&2
    printf '    %s\n' "${missing[@]}" >&2
    echo "Run this from the repository root, then rerun this script:" >&2
    echo "    pnpm install && pnpm build" >&2
    exit 1
fi

# HERMES_PYTHON, then hermes/.venv from scripts/setup-hermes.sh, then python3 on PATH.
hermes_python() {
    if [[ -n "${HERMES_PYTHON:-}" ]]; then
        echo "$HERMES_PYTHON"
    elif [[ -x "$ROOT/hermes/.venv/bin/python" ]]; then
        echo "$ROOT/hermes/.venv/bin/python"
    else
        echo python3
    fi
}

hermes_setup_help() {
    cat >&2 <<EOF
Create the Hermes virtualenv, then rerun this script:

    bash scripts/setup-hermes.sh          # Python 3.14, downloaded by uv if missing
    bash scripts/setup-hermes.sh 3.12     # or another Python from 3.11 to 3.14

Or set HERMES_PYTHON to a Python that can already import Hermes.
EOF
}

# ETL opens etl.sqlite with node:sqlite. `#!/usr/bin/env node` in
# packages/server/bin/run follows PATH, which can be an older binary than the
# Node 24 in .nvmrc. Pick a binary that can load the built-in (Node 22.5–22.12
# need --experimental-sqlite) before Hermes or the server start.
# $(...) drops trailing newlines. An empty flag line would disappear, and the
# node path would be passed twice, so Node would try to execute its own binary.
pick_file="$(mktemp)"
if ! node "$ROOT/scripts/pick-cuttlely-node.mjs" >"$pick_file"; then
    status=$?
    rm -f "$pick_file"
    exit "$status"
fi
NODE_BIN="$(sed -n '1p' "$pick_file")"
NODE_FLAG="$(sed -n '2p' "$pick_file")"
rm -f "$pick_file"
NODE_CMD=("$NODE_BIN")
if [[ -n "$NODE_FLAG" ]]; then
    NODE_CMD+=("$NODE_FLAG")
fi
echo "Cuttlely node: $NODE_BIN ($("$NODE_BIN" -v))"

mkdir -p "$HERMES_HOME"
PYTHON="$(hermes_python)"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "Hermes Python not found: $PYTHON" >&2
    hermes_setup_help
    exit 1
fi
if ! IMPORT_ERROR="$(cd "$ROOT/hermes" && "$PYTHON" -c 'import aiohttp, cli' 2>&1)"; then
    echo "Hermes Python $PYTHON cannot import the vendored Hermes runtime:" >&2
    echo "    $(printf '%s\n' "$IMPORT_ERROR" | tail -n 1)" >&2
    hermes_setup_help
    exit 1
fi
echo "Hermes Python: $PYTHON"

# Hermes exits under load (watchdog exit 75) and nothing used to bring it back.
# Restart with backoff until CUTTLELY_HERMES_MAX_RESTARTS, then leave a status file ping can read.
HERMES_MAX_RESTARTS="${CUTTLELY_HERMES_MAX_RESTARTS:-5}"
HERMES_STOP="$DATA/hermes-supervisor.stop"
rm -f "$HERMES_STOP"
write_hermes_status() {
    "$NODE_BIN" "$ROOT/scripts/hermes-health.mjs" write "$1" "$2" "$3" "$4"
}
hermes_backoff_seconds() {
    local n="$1"
    if [[ -n "${CUTTLELY_HERMES_RESTART_DELAY:-}" ]]; then
        echo "$CUTTLELY_HERMES_RESTART_DELAY"
        return
    fi
    if [[ "$n" -lt 1 ]]; then
        n=1
    fi
    echo $((n * 2))
}
# A process that was answering /health and then stops is shutting down or stuck.
# kill -0 stays true until the pid is gone, which left the header at "up" for seconds.
hermes_answers_health() {
    if [[ -n "${CUTTLELY_HERMES_HEALTH_CHECK:-}" ]]; then
        "${CUTTLELY_HERMES_HEALTH_CHECK}"
        return
    fi
    "$NODE_BIN" -e '
        const http = require("http")
        const port = process.env.API_SERVER_PORT || "8642"
        const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 2000 }, (res) => {
            res.resume()
            process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1)
        })
        req.on("timeout", () => { req.destroy(); process.exit(1) })
        req.on("error", () => process.exit(1))
    '
}
# Docker and Render start this script (Dockerfile CMD, scripts/render-entrypoint.sh).
# Hermes lists MCP tools at boot, so it starts only after the harness gateway answers.
GATEWAY_PORT="${CUTTLELY_HARNESS_GATEWAY_PORT:-43118}"
export CUTTLELY_HARNESS_GATEWAY_PORT="$GATEWAY_PORT"
gateway_answers() {
    if [[ -n "${CUTTLELY_GATEWAY_HEALTH_CHECK:-}" ]]; then
        "${CUTTLELY_GATEWAY_HEALTH_CHECK}"
        return
    fi
    "$NODE_BIN" -e '
        const http = require("http")
        const port = process.env.CUTTLELY_HARNESS_GATEWAY_PORT || "43118"
        const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 400 }, (res) => {
            res.resume()
            process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1)
        })
        req.on("timeout", () => { req.destroy(); process.exit(1) })
        req.on("error", () => process.exit(1))
    '
}
wait_for_gateway() {
    local limit="${CUTTLELY_GATEWAY_WAIT_SECONDS:-180}"
    local i=0
    local port="${CUTTLELY_HARNESS_GATEWAY_PORT:-43118}"
    echo "Waiting for the harness gateway on 127.0.0.1:${port}."
    while [[ "$i" -lt "$limit" ]]; do
        if [[ -n "${CUTTLELY_PID:-}" ]] && ! kill -0 "$CUTTLELY_PID" 2>/dev/null; then
            echo "Cuttlely exited before the harness gateway answered." >&2
            return 1
        fi
        if gateway_answers; then
            echo "Harness gateway is answering on 127.0.0.1:${port}."
            return 0
        fi
        i=$((i + 1))
        sleep 1
    done
    echo "Harness gateway on 127.0.0.1:${port} did not answer within ${limit}s. Hermes will not start." >&2
    return 1
}
kill_hermes_pid() {
    local pid="$1"
    local grace=0
    # pid 0 (the status file's "down") would signal this whole process group.
    if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    kill "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null && [[ "$grace" -lt 10 ]]; do
        sleep 0.2
        grace=$((grace + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi
}
start_hermes_once() {
    "$PYTHON" "$ROOT/scripts/cuttlely-hermes-api.py" &
    HERMES_PID=$!
}
# This function starts Hermes itself. wait on a pid from the parent shell returns 127.
supervise_hermes() {
    local restarts=0
    local status=0
    local delay=0
    while true; do
        if [[ -f "$HERMES_STOP" ]]; then
            return 0
        fi
        start_hermes_once
        if [[ "$restarts" -gt 0 ]]; then
            echo "Hermes restarted pid ${HERMES_PID} (restart ${restarts} of ${HERMES_MAX_RESTARTS})." >&2
        fi
        write_hermes_status up "$restarts" "" "$HERMES_PID"
        local healthy_once=0
        local marked=0
        local ticks=0
        local fails=0
        local fail_started=0
        local posted=up
        local started_at
        started_at="$(date +%s)"
        # Warm-up answers /health once, then spends the next minute loading tools.
        # Misses in that window are not a stall. After it, a restart needs both the
        # fail count and CUTTLELY_HERMES_HEALTH_WINDOW seconds of continuous misses.
        local health_grace="${CUTTLELY_HERMES_HEALTH_GRACE:-60}"
        local health_fails="${CUTTLELY_HERMES_HEALTH_FAILS:-3}"
        local health_window="${CUTTLELY_HERMES_HEALTH_WINDOW:-15}"
        while kill -0 "$HERMES_PID" 2>/dev/null; do
            if [[ -f "$HERMES_STOP" ]]; then
                kill_hermes_pid "$HERMES_PID"
                wait "$HERMES_PID" 2>/dev/null || true
                return 0
            fi
            ticks=$((ticks + 1))
            if [[ "$ticks" -ge 5 ]]; then
                ticks=0
                if hermes_answers_health; then
                    healthy_once=1
                    fails=0
                    fail_started=0
                    if [[ "$posted" != "up" ]]; then
                        write_hermes_status up "$restarts" "" "$HERMES_PID"
                        posted=up
                    fi
                elif [[ "$healthy_once" -eq 1 ]]; then
                    local now
                    now="$(date +%s)"
                    local in_grace=0
                    if [[ "$health_grace" -gt 0 && $((now - started_at)) -lt "$health_grace" ]]; then
                        in_grace=1
                    fi
                    # A live event stream means Hermes is serving a harness run.
                    # Health misses during that stream are not a reason to kill it.
                    # An exited process still leaves this loop and restarts below.
                    local stream_open=0
                    if [[ -n "${CUTTLELY_HERMES_STREAM_CHECK:-}" ]]; then
                        if "${CUTTLELY_HERMES_STREAM_CHECK}"; then
                            stream_open=1
                        fi
                    elif [[ -n "${NODE_BIN:-}" && -n "${ROOT:-}" && -d "$DATA/hermes-streams" ]]; then
                        if "$NODE_BIN" "$ROOT/packages/harness/runtime/hermes-stream.mjs" active; then
                            stream_open=1
                        fi
                    fi
                    if [[ "$in_grace" -eq 1 || "$stream_open" -eq 1 ]]; then
                        fails=0
                        fail_started=0
                    else
                        if [[ "$fails" -eq 0 ]]; then
                            fail_started="$now"
                        fi
                        fails=$((fails + 1))
                        local elapsed=$((now - fail_started))
                        local window_hit=0
                        if [[ "$health_window" -eq 0 || "$elapsed" -ge "$health_window" ]]; then
                            window_hit=1
                        fi
                        if [[ "$fails" -ge "$health_fails" && "$window_hit" -eq 1 ]]; then
                            restarts=$((restarts + 1))
                            marked=1
                            if [[ "$restarts" -gt "$HERMES_MAX_RESTARTS" ]]; then
                                echo "Hermes failed ${fails} health checks. Restart limit ${HERMES_MAX_RESTARTS} reached. Hermes stays down." >&2
                                write_hermes_status down "$restarts" "health" 0
                                kill_hermes_pid "$HERMES_PID"
                                wait "$HERMES_PID" 2>/dev/null || true
                                return 0
                            fi
                            echo "Hermes failed ${fails} health checks. Restart ${restarts} of ${HERMES_MAX_RESTARTS}." >&2
                            write_hermes_status restarting "$restarts" "health" 0
                            posted=restarting
                            kill_hermes_pid "$HERMES_PID"
                            break
                        fi
                        if [[ "$posted" != "degraded" ]]; then
                            echo "Hermes missed a health check (${fails} of ${health_fails})." >&2
                            write_hermes_status degraded "$restarts" "health" "$HERMES_PID"
                            posted=degraded
                        fi
                    fi
                fi
            fi
            sleep 0.2
        done
        status=0
        wait "$HERMES_PID" || status=$?
        if [[ -f "$HERMES_STOP" ]]; then
            return 0
        fi
        if [[ "$marked" -eq 0 ]]; then
            restarts=$((restarts + 1))
        fi
        delay="$(hermes_backoff_seconds "$restarts")"
        if [[ "$restarts" -gt "$HERMES_MAX_RESTARTS" ]]; then
            echo "Hermes exited with status ${status}. Restart limit ${HERMES_MAX_RESTARTS} reached. Hermes stays down." >&2
            write_hermes_status down "$restarts" "exit ${status}" 0
            return 0
        fi
        echo "Hermes exited with status ${status}. Restart ${restarts} of ${HERMES_MAX_RESTARTS} in ${delay}s." >&2
        write_hermes_status restarting "$restarts" "exit ${status}" 0
        sleep "$delay"
        if [[ -f "$HERMES_STOP" ]]; then
            return 0
        fi
    done
}
echo "Cuttlely boot, step 1 of 2: starting the server on port ${PORT:-43117}. A browser opened now shows a 'Cuttlely is starting' page."
cd "$ROOT/packages/server/bin"
"${NODE_CMD[@]}" ./run start &
CUTTLELY_PID=$!
cd "$ROOT"
if ! wait_for_gateway; then
    if [[ -n "${CUTTLELY_PID:-}" ]] && kill -0 "$CUTTLELY_PID" 2>/dev/null; then
        write_hermes_status down 0 "gateway" 0
        echo "Cuttlely is up. Hermes stays down until the harness gateway answers and Cuttlely is started again." >&2
    else
        status=0
        wait "$CUTTLELY_PID" || status=$?
        exit "$status"
    fi
else
    echo "Cuttlely boot, step 2 of 2: starting the agent runtime (Hermes) in the background. Agent teams answer once it is up, usually within a minute."
    supervise_hermes &
    HERMES_SUPERVISOR_PID=$!
fi
WORKER_PIDS=()
if [[ "${CUTTLELY_HARNESS_QUEUE:-inline}" == "external" ]]; then
    count="${CUTTLELY_HARNESS_WORKERS:-1}"
    i=1
    while [[ "$i" -le "$count" ]]; do
        "${NODE_CMD[@]}" "$ROOT/packages/harness/worker.mjs" &
        WORKER_PIDS+=("$!")
        i=$((i + 1))
    done
    echo "Harness workers: ${#WORKER_PIDS[@]} (queue external, each worker boots the Flowise node pool, Hermes stays on 127.0.0.1)"
else
    echo "Harness queue: ${CUTTLELY_HARNESS_QUEUE:-inline}"
fi

cleanup() {
    # Cuttlely first, and wait for it: on SIGTERM it lets running answers and streams finish (CUTTLELY_DRAIN_TIMEOUT_MS,
    # 25 seconds by default, then it ends the rest and exits). Hermes stays up meanwhile so agent team runs can finish.
    if [[ -n "${CUTTLELY_PID:-}" ]] && kill -0 "$CUTTLELY_PID" 2>/dev/null; then
        kill "$CUTTLELY_PID" 2>/dev/null || true
        wait "$CUTTLELY_PID" 2>/dev/null || true
    fi
    touch "$HERMES_STOP"
    if [[ -n "${HERMES_SUPERVISOR_PID:-}" ]] && kill -0 "$HERMES_SUPERVISOR_PID" 2>/dev/null; then
        kill "$HERMES_SUPERVISOR_PID" 2>/dev/null || true
        wait "$HERMES_SUPERVISOR_PID" 2>/dev/null || true
    fi
    if [[ -f "$DATA/hermes-supervisor.json" ]]; then
        local pid
        pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$DATA/hermes-supervisor.json")"
        # Wait for it to go, so a restart in place does not find the Hermes port still taken.
        kill_hermes_pid "$pid"
    elif [[ -n "${HERMES_PID:-}" ]]; then
        kill_hermes_pid "$HERMES_PID"
    fi
    for pid in "${WORKER_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
}
trap cleanup EXIT

if [[ -n "${CUTTLELY_PID:-}" ]]; then
    status=0
    wait "$CUTTLELY_PID" || status=$?
    exit "$status"
fi
