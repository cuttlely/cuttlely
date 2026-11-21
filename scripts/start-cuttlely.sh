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
    recovery_restart=0
    forward_stop() {
        stopping=1
        if [[ -n "$inner_pid" ]]; then
            kill -TERM "$inner_pid" 2>/dev/null || true
        fi
    }
    trap forward_stop TERM INT
    # Only the first inner copy is the container's first boot. Every later copy is a restart in place, where
    # /api/v1/ping/live answers as soon as the server listens and the profile recompile gates readiness only.
    unset CUTTLELY_STACK_RESTARTED
    while true; do
        if [[ "$recovery_restart" -eq 1 ]]; then
            # Reuse the boot gate's existing background-compile cap on recovery only.
            # Keep this outage below Render's sustained-failure window as well as Docker's probe budget.
            recovery_cap="${CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS:-180}"
            if [[ ! "$recovery_cap" =~ ^[0-9]+$ ]] || [[ "$recovery_cap" -gt 10 ]]; then recovery_cap=10; fi
            CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS="$recovery_cap" CUTTLELY_START_INNER=1 bash "$ROOT/scripts/start-cuttlely.sh" "$@" &
        else
            CUTTLELY_START_INNER=1 bash "$ROOT/scripts/start-cuttlely.sh" "$@" &
        fi
        inner_pid=$!
        status=0
        wait "$inner_pid" || status=$?
        # A signal ends wait early. Wait again for the real exit status.
        while kill -0 "$inner_pid" 2>/dev/null; do
            status=0
            wait "$inner_pid" || status=$?
        done
        inner_pid=""
        export CUTTLELY_STACK_RESTARTED=1
        # 76: the server could not get ready with changed server settings. Start it again so safe boot can count the
        # failed start; after two, it puts back the last settings that worked. It never loops: with the settings that
        # last worked, the server does not exit with 76.
        if [[ "$stopping" -eq 1 || ( "$status" -ne 75 && "$status" -ne 76 ) ]]; then
            exit "$status"
        fi
        recovery_restart=0
        if [[ "$status" -eq 75 ]] && [[ -f "${CUTTLELY_DATA_DIR:-$ROOT/.cuttlely}/hermes-supervisor.json" ]] &&
            grep -q '"detail":"cooldown complete"' "${CUTTLELY_DATA_DIR:-$ROOT/.cuttlely}/hermes-supervisor.json"; then
            recovery_restart=1
        fi
        if [[ "$status" -eq 76 ]]; then
            echo "Cuttlely could not start with the saved server settings. Starting again (safe boot puts back the last settings that worked after two tries)."
        elif [[ "$recovery_restart" -eq 1 ]]; then
            echo "Restarting Cuttlely and the agent runtime after cooldown."
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
# Unset Analyst storage is Auto. off, false, 0, and no stay off. A saved Server settings
# value is already in the environment from the helper above, so it wins over this default.
if [[ -z "${CUTTLELY_ANALYST:-}" ]]; then
    export CUTTLELY_ANALYST=auto
    script_defaults+=(CUTTLELY_ANALYST)
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

# Restart budgets cover consecutive failures; successful health checks replenish the budget.
HERMES_STOP="$DATA/hermes-supervisor.stop"
HERMES_PARENT_PID=$$
rm -f "$HERMES_STOP"
hermes_number() {
    local name="$1" fallback="$2" kind="${3:-seconds}" value="${!1:-}"
    if [[ -z "$value" ]]; then
        value="$fallback"
    elif [[ ! "$value" =~ ^[0-9]{1,8}([.][0-9]{1,6})?$ ]] ||
        { [[ "$kind" == integer ]] && [[ ! "$value" =~ ^[0-9]{1,8}$ ]]; }; then
        echo "$name is not a valid non-negative $kind value. Using $fallback." >&2
        value="$fallback"
    fi
    if [[ "$kind" == integer ]]; then
        value=$((10#$value))
    fi
    printf -v "$name" '%s' "$value"
}
configure_hermes_supervisor() {
    hermes_number CUTTLELY_HERMES_MAX_RESTARTS 5 integer
    hermes_number CUTTLELY_HERMES_HEALTHY_RESET_SECONDS 600
    hermes_number CUTTLELY_HERMES_RESTART_BACKOFF_MAX_SECONDS 60
    if [[ -n "${CUTTLELY_HERMES_RESTART_DELAY:-}" ]]; then
        hermes_number CUTTLELY_HERMES_RESTART_DELAY 2
    fi
    hermes_number CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS 300
    if awk -v n="$CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS" 'BEGIN { exit !(n > 3600) }'; then
        echo "CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS exceeds the 3600s cap. Using 3600." >&2
        CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS=3600
    fi
    hermes_number CUTTLELY_HERMES_HEALTH_GRACE 60
    hermes_number CUTTLELY_HERMES_HEALTH_FAILS 3 integer
    hermes_number CUTTLELY_HERMES_HEALTH_WINDOW 15
    hermes_number CUTTLELY_HERMES_STOP_GRACE_SECONDS 15 integer
    HERMES_MAX_RESTARTS="$CUTTLELY_HERMES_MAX_RESTARTS"
}
write_hermes_status() {
    "$NODE_BIN" "$ROOT/scripts/hermes-health.mjs" write "$1" "$2" "$3" "$4" "${lifetime_restarts:-0}" "${HERMES_MAX_RESTARTS:-5}" "${HERMES_ESCALATION_ACTION:-cooldown}"
}
hermes_backoff_seconds() {
    if [[ -n "${CUTTLELY_HERMES_RESTART_DELAY:-}" ]]; then
        awk -v delay="$CUTTLELY_HERMES_RESTART_DELAY" -v cap="$CUTTLELY_HERMES_RESTART_BACKOFF_MAX_SECONDS" 'BEGIN { print delay < cap ? delay : cap }'
        return
    fi
    awk -v n="$1" -v base=2 -v cap="$CUTTLELY_HERMES_RESTART_BACKOFF_MAX_SECONDS" 'BEGIN {
        delay = base
        for (i = 1; i < n && delay < cap; i++) delay *= 2
        if (delay > cap) delay = cap
        print delay
    }'
}
# Small slices let HERMES_STOP and signal traps interrupt even a long cooldown.
hermes_pause() {
    local remaining="$1" slice
    while awk -v n="$remaining" 'BEGIN { exit !(n > 0) }'; do
        [[ -f "$HERMES_STOP" ]] && return 1
        slice=$(awk -v n="$remaining" 'BEGIN { print n < 0.2 ? n : 0.2 }')
        sleep "$slice"
        remaining=$(awk -v n="$remaining" -v slice="$slice" 'BEGIN { print n - slice }')
    done
    [[ ! -f "$HERMES_STOP" ]]
}
hermes_clock() {
    "$NODE_BIN" -e 'console.log(Number(process.hrtime.bigint() / 1000000n) / 1000)'
}
hermes_diagnostics() {
    "$NODE_BIN" "$ROOT/scripts/hermes-fd-snapshot.mjs" "${3:-${HERMES_PID:-0}}" "$1" "${restarts:-}" "${HERMES_MAX_RESTARTS:-5}" "${lifetime_restarts:-}" "$2" || true
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
        // Connected but no answer in time: the server is up and busy compiling (synchronous file work), as with a 503.
        let connected = false
        req.on("socket", (socket) => socket.on("connect", () => (connected = true)))
        req.on("timeout", () => { req.destroy(); process.exit(connected ? 2 : 1) })
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
            // 503: the server is up and still compiling profiles from an older version, which Hermes must not load yet.
            if (res.statusCode === 503) process.exit(2)
            process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1)
        })
        // Connected but no answer in time: the server is up and busy compiling (synchronous file work), as with a 503.
        let connected = false
        req.on("socket", (socket) => socket.on("connect", () => (connected = true)))
        req.on("timeout", () => { req.destroy(); process.exit(connected ? 2 : 1) })
        req.on("error", () => process.exit(1))
    '
}
wait_for_gateway() {
    local limit="${CUTTLELY_GATEWAY_WAIT_SECONDS:-180}"
    # Once the gateway has said it is compiling profiles (503), wait this much longer, still only a few minutes.
    # Render drops a deploy that is not healthy within about 15 minutes. A compile that needs longer keeps going
    # in the server; this wait does not.
    local starting_limit="${CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS:-180}"
    if [[ ! "$starting_limit" =~ ^[0-9]+$ ]]; then
        echo "CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS=${starting_limit} is not a whole number of seconds. Using 180." >&2
        starting_limit=180
    elif [[ "$starting_limit" -gt 300 ]]; then
        echo "CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS=${starting_limit} is above 300s. The profile compile wait is capped at 300s so a deploy can finish." >&2
        starting_limit=300
    fi
    local starting=0
    local i=0
    local port="${CUTTLELY_HARNESS_GATEWAY_PORT:-43118}"
    local answer
    # hrtime has a shared monotonic origin across Node processes; wall-clock corrections cannot extend this cap.
    local clock_script='console.log(Number(process.hrtime.bigint() / 1000000000n))'
    local started_monotonic
    started_monotonic=$("$NODE_BIN" -e "$clock_script")
    GATEWAY_STILL_COMPILING=0
    echo "Waiting for the harness gateway on 127.0.0.1:${port}."
    # starting_limit is elapsed seconds since the wait began, not loop turns. The OR form let CUTTLELY_GATEWAY_WAIT_SECONDS run past it.
    while [[ "$(( $("$NODE_BIN" -e "$clock_script") - started_monotonic ))" -lt "$starting_limit" && ( "$starting" -eq 1 || "$i" -lt "$limit" ) ]]; do
        if [[ -n "${CUTTLELY_PID:-}" ]] && ! kill -0 "$CUTTLELY_PID" 2>/dev/null; then
            echo "Cuttlely exited before the harness gateway answered." >&2
            return 1
        fi
        answer=0
        gateway_answers || answer=$?
        if [[ "$answer" -eq 0 ]]; then
            echo "Harness gateway is answering on 127.0.0.1:${port}."
            return 0
        fi
        if [[ "$answer" -eq 2 && "$starting" -eq 0 ]]; then
            starting=1
            echo "Harness gateway is up and compiling agent profiles; Hermes starts when that is done."
        fi
        i=$((i + 1))
        sleep 1
    done
    local elapsed=$(( $("$NODE_BIN" -e "$clock_script") - started_monotonic ))
    if [[ "$starting" -eq 1 ]]; then
        GATEWAY_STILL_COMPILING=1
        echo "Harness gateway on 127.0.0.1:${port} was still compiling agent profiles after ${elapsed}s (cap ${starting_limit}s). The wait stops here so the deploy can finish. Hermes starts when that compile finishes." >&2
    else
        echo "Harness gateway on 127.0.0.1:${port} did not answer within ${elapsed}s (limit ${limit}s, cap ${starting_limit}s). Hermes will not start." >&2
    fi
    return 1
}
# The blocking wait hit its cap while profiles were still compiling. Poll until the gateway answers, then supervise
# the runtime. Chat and prediction stay 503 in the server until the compile finishes.
start_hermes_when_gateway_ready() {
    local answer
    echo "Waiting in the background for the profile compile to finish before starting the agent runtime."
    while true; do
        if [[ -f "$HERMES_STOP" ]]; then
            return 0
        fi
        if [[ -n "${CUTTLELY_PID:-}" ]] && ! kill -0 "$CUTTLELY_PID" 2>/dev/null; then
            echo "Cuttlely exited before the profile compile finished. The agent runtime will not start." >&2
            return 0
        fi
        answer=0
        gateway_answers || answer=$?
        if [[ "$answer" -eq 0 ]]; then
            echo "Harness gateway is answering on 127.0.0.1:${CUTTLELY_HARNESS_GATEWAY_PORT:-43118}. Starting the agent runtime."
            supervise_hermes
            return 0
        fi
        sleep 1
    done
}
kill_hermes_pid() {
    local pid="$1"
    local ticks=0 reason="${2:-shutdown}" grace deadline
    # pid 0 (the status file's "down") would signal this whole process group.
    if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    # cleanup also calls this from the parent shell, outside the configured supervisor.
    hermes_number CUTTLELY_HERMES_STOP_GRACE_SECONDS 15 integer
    grace="$CUTTLELY_HERMES_STOP_GRACE_SECONDS"
    # A container stop drains Node first. Both shells share the remaining 28s budget
    # through this monotonic deadline, with a floor of 2s (or the configured grace
    # if lower); a runtime-only restart keeps the full grace.
    if [[ -f "${HERMES_STOP:-}" ]]; then
        deadline="$(cat "$HERMES_STOP")"
        if [[ "$deadline" =~ ^[0-9]+$ ]]; then
            grace="$(awk -v deadline="$deadline" -v now="$(hermes_clock)" -v grace="$grace" 'BEGIN { floor = grace < 2 ? grace : 2; remaining = int(deadline - now); if (remaining < floor) remaining = floor; print remaining < grace ? remaining : grace }')"
        fi
    fi
    hermes_diagnostics "$reason" restart "$pid"
    kill -TERM "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null && [[ "$ticks" -lt "$((grace * 5))" ]]; do
        sleep 0.2
        ticks=$((ticks + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        hermes_diagnostics "$reason" restart "$pid"
        echo "Hermes SIGKILL escalation: pid=${pid} reason=${reason} stop grace=${grace}s." >&2
        kill -KILL "$pid" 2>/dev/null || true
    fi
}
start_hermes_once() {
    if ! "$NODE_BIN" "$ROOT/scripts/sweep-try-profiles.mjs" >/dev/null 2>&1; then
        echo "Hermes pre-start try-profile sweep failed; continuing runtime start." >&2
    fi
    "$PYTHON" "$ROOT/scripts/cuttlely-hermes-api.py" &
    HERMES_PID=$!
}
# This function starts Hermes itself. wait on a pid from the parent shell returns 127.
supervise_hermes() {
    configure_hermes_supervisor
    local restarts=0 lifetime_restarts status=0 delay=0 reason=""
    lifetime_restarts="$("$NODE_BIN" "$ROOT/scripts/hermes-health.mjs" lifetime)"
    # The background supervisor owns its child and must reap it on a stop signal.
    trap 'kill_hermes_pid "${HERMES_PID:-0}"; wait "${HERMES_PID:-0}" 2>/dev/null || true; exit 0' TERM INT
    while true; do
        [[ -f "$HERMES_STOP" ]] && return 0
        start_hermes_once
        if [[ "$lifetime_restarts" -gt 0 ]]; then
            echo "Hermes restarted pid ${HERMES_PID} (burst ${restarts} of ${HERMES_MAX_RESTARTS}, lifetime ${lifetime_restarts})." >&2
        fi
        local healthy_once=0 marked=0 ticks=0 fails=0 fail_started=0 posted=up healthy_since=""
        # Every launch (the cold start, a replacement after a runtime restart, or a launch in a stack restarted in place)
        # stays "restarting", so agent calls get 503, until its first health answer reopens it. One that never answers
        # within the deadline below counts as a failed start.
        local replacing=1 start_reason="starting"
        if [[ "$restarts" -gt 0 || "${CUTTLELY_STACK_RESTARTED:-0}" == "1" ]]; then
            start_reason="${reason:-replacement starting}"
        fi
        write_hermes_status restarting "$restarts" "$start_reason" "$HERMES_PID"
        posted=restarting
        local started_at now
        started_at="$(hermes_clock)"
        reason=""
        while kill -0 "$HERMES_PID" 2>/dev/null; do
            if [[ -f "$HERMES_STOP" ]]; then
                kill_hermes_pid "$HERMES_PID"
                wait "$HERMES_PID" 2>/dev/null || true
                return 0
            fi
            ticks=$((ticks + 1))
            if [[ "$ticks" -ge 5 ]]; then
                ticks=0
                now="$(hermes_clock)"
                if hermes_answers_health; then
                    healthy_once=1
                    fails=0
                    fail_started=0
                    [[ -z "$healthy_since" ]] && healthy_since="$now"
                    if [[ "$restarts" -gt 0 ]] && awk -v now="$now" -v since="$healthy_since" -v reset="$CUTTLELY_HERMES_HEALTHY_RESET_SECONDS" 'BEGIN { exit !(now - since >= reset) }'; then
                        echo "Hermes healthy window reached; burst reset from ${restarts} (budget ${HERMES_MAX_RESTARTS}, lifetime ${lifetime_restarts})." >&2
                        restarts=0
                        posted=reset
                    fi
                    if [[ "$posted" != up ]]; then
                        write_hermes_status up "$restarts" "" "$HERMES_PID"
                        posted=up
                    fi
                else
                    # Only continuous /health answers count, even during warm-up or an open stream.
                    healthy_since=""
                    # A replacement that never answers health is a failed start: it uses the restart budget, and so
                    # reaches cooldown and the stack restart, instead of refusing agent calls forever.
                    if [[ "$healthy_once" -eq 0 && "$replacing" -eq 1 ]] && awk -v now="$now" -v started="$started_at" -v grace="$CUTTLELY_HERMES_HEALTH_GRACE" -v window="$CUTTLELY_HERMES_HEALTH_WINDOW" 'BEGIN { exit !(now - started >= 2 * grace + window) }'; then
                        restarts=$((restarts + 1))
                        lifetime_restarts=$((lifetime_restarts + 1))
                        marked=1
                        reason="no health answer after start"
                        echo "Hermes replacement did not answer health after start. Restart ${restarts} of ${HERMES_MAX_RESTARTS} (lifetime ${lifetime_restarts})." >&2
                        write_hermes_status restarting "$restarts" "$reason" "$HERMES_PID"
                        kill_hermes_pid "$HERMES_PID" "$reason"
                        break
                    fi
                    if [[ "$healthy_once" -eq 1 ]]; then
                        local in_grace=0 stream_open=0
                        if awk -v now="$now" -v started="$started_at" -v grace="$CUTTLELY_HERMES_HEALTH_GRACE" 'BEGIN { exit !(now - started < grace) }'; then
                            in_grace=1
                        fi
                        # Preserve warm-up and active-stream protection against false stall kills.
                        if [[ -n "${CUTTLELY_HERMES_STREAM_CHECK:-}" ]]; then
                            if "${CUTTLELY_HERMES_STREAM_CHECK}"; then stream_open=1; fi
                        elif [[ -d "$DATA/hermes-streams" ]]; then
                            if "$NODE_BIN" "$ROOT/packages/harness/runtime/hermes-stream.mjs" active; then stream_open=1; fi
                        fi
                        if [[ "$in_grace" -eq 1 || "$stream_open" -eq 1 ]]; then
                            fails=0
                            fail_started=0
                        else
                            [[ "$fails" -eq 0 ]] && fail_started="$now"
                            fails=$((fails + 1))
                            if [[ "$fails" -ge "$CUTTLELY_HERMES_HEALTH_FAILS" ]] && awk -v now="$now" -v since="$fail_started" -v window="$CUTTLELY_HERMES_HEALTH_WINDOW" 'BEGIN { exit !(now - since >= window) }'; then
                                restarts=$((restarts + 1))
                                lifetime_restarts=$((lifetime_restarts + 1))
                                marked=1
                                reason="health failures ${fails}"
                                echo "Hermes failed ${fails} health checks. Restart ${restarts} of ${HERMES_MAX_RESTARTS} (lifetime ${lifetime_restarts})." >&2
                                write_hermes_status restarting "$restarts" "$reason" "$HERMES_PID"
                                kill_hermes_pid "$HERMES_PID" "$reason"
                                break
                            fi
                            if [[ "$posted" != degraded ]]; then
                                echo "Hermes missed a health check (${fails} of ${CUTTLELY_HERMES_HEALTH_FAILS})." >&2
                                write_hermes_status degraded "$restarts" health "$HERMES_PID"
                                posted=degraded
                            fi
                        fi
                    fi
                fi
            fi
            sleep 0.2
        done
        status=0
        wait "$HERMES_PID" || status=$?
        [[ -f "$HERMES_STOP" ]] && return 0
        if [[ "$marked" -eq 0 ]]; then
            restarts=$((restarts + 1))
            lifetime_restarts=$((lifetime_restarts + 1))
            reason="exit ${status}"
        fi
        if [[ "$restarts" -gt "$HERMES_MAX_RESTARTS" ]]; then
            echo "Hermes exited with status ${status}." >&2
            hermes_final_escalation "$reason"
            return $?
        fi
        delay="$(hermes_backoff_seconds "$restarts")"
        echo "Hermes exited with status ${status}. Restart ${restarts} of ${HERMES_MAX_RESTARTS} in ${delay}s (lifetime ${lifetime_restarts})." >&2
        write_hermes_status restarting "$restarts" "$reason" 0
        hermes_pause "$delay" || return 0
    done
}

# All budget-exhaustion policy lives here. Default recovery keeps Node serving through
# cooldown, then uses the outer loop's existing whole-stack restart-in-place path.
hermes_final_escalation() {
    local reason="$1" escalation_status=75 state=cooldown
    HERMES_ESCALATION_ACTION=cooldown
    if [[ "${CUTTLELY_EXIT_ON_EXHAUSTED:-0}" == 1 ]]; then
        HERMES_ESCALATION_ACTION=exit
        escalation_status=70
        state=exhausted
    fi
    hermes_diagnostics "$reason" "$HERMES_ESCALATION_ACTION"
    write_hermes_status "$state" "$restarts" "$reason" 0
    echo "Hermes restart limit ${HERMES_MAX_RESTARTS} reached (burst ${restarts}, lifetime ${lifetime_restarts}, action ${HERMES_ESCALATION_ACTION})." >&2
    if [[ "$HERMES_ESCALATION_ACTION" == cooldown ]]; then
        echo "Hermes exhausted; cooldown ${CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS}s before restarting the whole stack in place." >&2
        hermes_pause "$CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS" || return 0
        restarts=0
        write_hermes_status restarting "$restarts" "cooldown complete" 0
    fi
    if [[ -n "${HERMES_PARENT_PID:-}" && "$HERMES_PARENT_PID" != "$BASHPID" ]]; then
        if [[ "$escalation_status" -eq 75 ]]; then
            kill -USR1 "$HERMES_PARENT_PID"
        else
            kill -USR2 "$HERMES_PARENT_PID"
        fi
    fi
    return "$escalation_status"
}

WORKER_PIDS=()

cleanup() {
    local shutdown_deadline
    shutdown_deadline="$(awk -v now="$(hermes_clock)" 'BEGIN { print int(now) + 28 }')"
    # Cuttlely first, and wait for it: on SIGTERM it lets running answers and streams finish (CUTTLELY_DRAIN_TIMEOUT_MS,
    # 25 seconds by default, then it ends the rest and exits). Hermes stays up meanwhile so agent team runs can finish.
    if [[ -n "${CUTTLELY_PID:-}" ]] && kill -0 "$CUTTLELY_PID" 2>/dev/null; then
        kill "$CUTTLELY_PID" 2>/dev/null || true
        if [[ "${HERMES_RECOVERY_RESTART:-0}" -eq 1 ]]; then
            # The runtime is already unavailable. Bound this drain to 5s so a configured
            # long drain cannot consume Render's ~60s liveness failure window.
            local drain_ticks=0
            while kill -0 "$CUTTLELY_PID" 2>/dev/null && [[ "$drain_ticks" -lt 25 ]]; do
                sleep 0.2
                drain_ticks=$((drain_ticks + 1))
            done
            kill -KILL "$CUTTLELY_PID" 2>/dev/null || true
        fi
        wait "$CUTTLELY_PID" 2>/dev/null || true
    fi
    printf '%s\n' "$shutdown_deadline" > "$HERMES_STOP"
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

# Exhausted runtime recovery exits the inner script through the same drain path as a normal stop.
trap 'HERMES_RECOVERY_RESTART=1; exit 75' USR1
trap 'exit 70' USR2
trap 'exit 143' TERM
trap 'exit 130' INT

echo "Cuttlely boot, step 1 of 2: starting the server on port ${PORT:-43117}. A browser opened now shows a 'Cuttlely is starting' page."
cd "$ROOT/packages/server/bin"
# /health and /api/v1/ping answer 503 until the server has compiled outdated agent profiles, so the runtime waits.
CUTTLELY_GATEWAY_HOLD_UNTIL_BOOT="${CUTTLELY_GATEWAY_HOLD_UNTIL_BOOT:-1}" "${NODE_CMD[@]}" ./run start &
CUTTLELY_PID=$!
# Only the server reads the first-owner password values. The agent runtime and everything else started below must not
# inherit them. The *_FILE paths stay: they name a file, not a secret.
unset CUTTLELY_INITIAL_OWNER_PASSWORD CUTTLELY_INITIAL_OWNER_PASSWORD_HASH
cd "$ROOT"
if ! wait_for_gateway; then
    if [[ -n "${CUTTLELY_PID:-}" ]] && kill -0 "$CUTTLELY_PID" 2>/dev/null; then
        # After a restart in place the wait is capped short, so a server that is still loading has simply not answered
        # yet. Keep waiting in the background rather than leave the runtime down until the next restart.
        if [[ "${GATEWAY_STILL_COMPILING:-0}" -eq 1 || "${CUTTLELY_STACK_RESTARTED:-0}" == "1" ]]; then
            # Do not record the runtime as down: that would hold /api/v1/ping at 503 for the rest of the deploy.
            echo "Cuttlely is up. The profile compile continues in the background. Chat and prediction answer 503 until it finishes." >&2
            start_hermes_when_gateway_ready &
            HERMES_SUPERVISOR_PID=$!
        else
            write_hermes_status down 0 "gateway" 0
            echo "Cuttlely is up. Hermes stays down until the harness gateway answers and Cuttlely is started again." >&2
        fi
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
if [[ "${CUTTLELY_HARNESS_QUEUE:-inline}" == "external" ]]; then
    count="${CUTTLELY_HARNESS_WORKERS:-1}"
    i=1
    while [[ "$i" -le "$count" ]]; do
        "${NODE_CMD[@]}" "$ROOT/packages/harness/worker.mjs" &
        WORKER_PIDS+=("$!")
        i=$((i + 1))
    done
    echo "Harness workers: ${#WORKER_PIDS[@]} (queue external, each worker boots the Cuttlely node pool, Hermes stays on 127.0.0.1)"
else
    echo "Harness queue: ${CUTTLELY_HARNESS_QUEUE:-inline}"
fi

if [[ -n "${CUTTLELY_PID:-}" ]]; then
    status=0
    wait "$CUTTLELY_PID" || status=$?
    exit "$status"
fi
