import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pingForHermesStatus, readHermesStatus, writeHermesStatus } from './hermes-health.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('hermes supervisor status', () => {
    it('writes a status ping can turn into hermes down', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-status-'))
        try {
            assert.equal(readHermesStatus(dir), null)
            assert.deepEqual(pingForHermesStatus(null), { code: 200, body: 'pong', header: 'unknown' })
            writeHermesStatus(dir, { state: 'degraded', restarts: 0, pid: 4, detail: 'health' })
            assert.equal(pingForHermesStatus(readHermesStatus(dir)).header, 'degraded')
            writeHermesStatus(dir, { state: 'restarting', restarts: 1, pid: 0, detail: 'exit 75' })
            assert.equal(pingForHermesStatus(readHermesStatus(dir)).header, 'restarting')
            writeHermesStatus(dir, { state: 'down', restarts: 6, pid: 0, detail: 'exit 75' })
            const down = readHermesStatus(dir)
            assert.equal(down.state, 'down')
            assert.equal(down.detail, 'exit 75')
            assert.deepEqual(pingForHermesStatus(down), { code: 503, body: 'hermes down', header: 'down' })
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('restarts a child that exits, then stops at the limit and logs each restart', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-loop-'))
        const log = path.join(dir, 'supervisor.log')
        const script = `
set -euo pipefail
DATA=${JSON.stringify(dir)}
export CUTTLELY_DATA_DIR="$DATA"
export CUTTLELY_HERMES_MAX_RESTARTS=2
export CUTTLELY_HERMES_RESTART_DELAY=0
HERMES_MAX_RESTARTS=2
ROOT=${JSON.stringify(ROOT)}
NODE_BIN=${JSON.stringify(process.execPath)}
HERMES_STOP="$DATA/hermes-supervisor.stop"
write_hermes_status() { "$NODE_BIN" "$ROOT/scripts/hermes-health.mjs" write "$1" "$2" "$3" "$4"; }
hermes_backoff_seconds() { echo "\${CUTTLELY_HERMES_RESTART_DELAY:-0}"; }
hermes_answers_health() { return 1; }
kill_hermes_pid() { local pid="$1"; if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi; }
start_hermes_once() { "$NODE_BIN" -e 'process.exit(75)' & HERMES_PID=$!; }
${fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8').match(/supervise_hermes\(\) \{[\s\S]*?\n\}/)[0]}
supervise_hermes
`
        try {
            const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] })
            let combined = ''
            child.stdout.on('data', (chunk) => {
                combined += chunk
            })
            child.stderr.on('data', (chunk) => {
                combined += chunk
            })
            const code = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGTERM')
                    reject(new Error(`supervisor did not finish\n${combined}`))
                }, 15000)
                child.on('exit', (status) => {
                    clearTimeout(timer)
                    resolve(status)
                })
            })
            fs.writeFileSync(log, combined)
            assert.equal(code, 0, combined)
            assert.match(combined, /Restart 1 of 2/)
            assert.match(combined, /Restart 2 of 2/)
            assert.match(combined, /Restart limit 2 reached/)
            assert.match(combined, /exited with status 75/)
            assert.doesNotMatch(combined, /exited with status 127/)
            const status = readHermesStatus(dir)
            assert.equal(status.state, 'down')
            assert.equal(status.detail, 'exit 75')
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('marks restarting when health stops and logs the child exit code', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-health-'))
        const script = `
set -euo pipefail
DATA=${JSON.stringify(dir)}
export CUTTLELY_DATA_DIR="$DATA"
export CUTTLELY_HERMES_MAX_RESTARTS=1
export CUTTLELY_HERMES_RESTART_DELAY=0
export CUTTLELY_HERMES_HEALTH_GRACE=0
export CUTTLELY_HERMES_HEALTH_WINDOW=0
export STATUS_FILE="$DATA/hermes-supervisor.json"
export COUNT_FILE="$DATA/count"
echo 0 > "$COUNT_FILE"
HERMES_MAX_RESTARTS=1
ROOT=${JSON.stringify(ROOT)}
NODE_BIN=${JSON.stringify(process.execPath)}
HERMES_STOP="$DATA/hermes-supervisor.stop"
write_hermes_status() { "$NODE_BIN" "$ROOT/scripts/hermes-health.mjs" write "$1" "$2" "$3" "$4"; }
hermes_backoff_seconds() { echo "0"; }
hermes_answers_health() {
    if [[ -f "$DATA/healthy-once" ]]; then
        return 1
    fi
    touch "$DATA/healthy-once"
    return 0
}
kill_hermes_pid() { local pid="$1"; if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi; }
export CUTTLELY_HERMES_HEALTH_FAILS=2
start_hermes_once() {
    "$NODE_BIN" -e '
        const fs = require("fs")
        const n = Number(fs.readFileSync(process.env.COUNT_FILE, "utf8") || "0") + 1
        fs.writeFileSync(process.env.COUNT_FILE, String(n))
        if (n > 1) process.exit(75)
        const started = Date.now()
        const timer = setInterval(() => {
            let body = {}
            try { body = JSON.parse(fs.readFileSync(process.env.STATUS_FILE, "utf8")) } catch {}
            if (body.state === "restarting") {
                clearInterval(timer)
                setTimeout(() => process.exit(75), 200)
            }
            if (Date.now() - started > 8000) process.exit(9)
        }, 40)
    ' &
    HERMES_PID=$!
}
${fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8').match(/supervise_hermes\(\) \{[\s\S]*?\n\}/)[0]}
supervise_hermes
`
        try {
            const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] })
            let combined = ''
            child.stdout.on('data', (chunk) => {
                combined += chunk
            })
            child.stderr.on('data', (chunk) => {
                combined += chunk
            })
            const code = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGTERM')
                    reject(new Error(`supervisor did not finish\n${combined}`))
                }, 15000)
                child.on('exit', (status) => {
                    clearTimeout(timer)
                    resolve(status)
                })
            })
            assert.equal(code, 0, combined)
            assert.match(combined, /exited with status 75/)
            assert.doesNotMatch(combined, /exited with status 127/)
            assert.equal(readHermesStatus(dir).detail, 'exit 75')
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('a single missed health check is degraded and the next success is up', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-blip-'))
        const script = `
set -euo pipefail
DATA=${JSON.stringify(dir)}
export CUTTLELY_DATA_DIR="$DATA"
export CUTTLELY_HERMES_MAX_RESTARTS=2
export CUTTLELY_HERMES_RESTART_DELAY=0
export CUTTLELY_HERMES_HEALTH_GRACE=0
export CUTTLELY_HERMES_HEALTH_FAILS=3
export PROBES="$DATA/probes"
echo 0 > "$PROBES"
HERMES_MAX_RESTARTS=2
ROOT=${JSON.stringify(ROOT)}
NODE_BIN=${JSON.stringify(process.execPath)}
HERMES_STOP="$DATA/hermes-supervisor.stop"
write_hermes_status() { "$NODE_BIN" "$ROOT/scripts/hermes-health.mjs" write "$1" "$2" "$3" "$4"; }
hermes_backoff_seconds() { echo "0"; }
hermes_answers_health() {
    n=$(cat "$PROBES")
    n=$((n + 1))
    echo "$n" > "$PROBES"
    if [[ "$n" -eq 2 ]]; then
        return 1
    fi
    return 0
}
kill_hermes_pid() { local pid="$1"; if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi; }
start_hermes_once() { "$NODE_BIN" -e 'setInterval(() => {}, 1000)' & HERMES_PID=$!; }
${fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8').match(/supervise_hermes\(\) \{[\s\S]*?\n\}/)[0]}
supervise_hermes
`
        const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] })
        let combined = ''
        child.stdout.on('data', (chunk) => {
            combined += chunk
        })
        child.stderr.on('data', (chunk) => {
            combined += chunk
        })
        try {
            const seen = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`blip did not recover\n${combined}`)), 12000)
                const poll = setInterval(() => {
                    const status = readHermesStatus(dir)
                    if (status?.state === 'degraded') seenDegraded = true
                    if (seenDegraded && status?.state === 'up' && status.restarts === 0) {
                        clearInterval(poll)
                        clearTimeout(timer)
                        resolve(status)
                    }
                }, 100)
                let seenDegraded = false
            })
            fs.writeFileSync(path.join(dir, 'hermes-supervisor.stop'), '1')
            await new Promise((resolve) => child.on('exit', resolve))
            assert.equal(seen.state, 'up')
            assert.equal(seen.restarts, 0)
            assert.doesNotMatch(combined, /Restart 1 of/)
        } finally {
            child.kill('SIGTERM')
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('does not start Hermes until the gateway answers', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-gateway-order-'))
        const ready = path.join(dir, 'gateway-ready')
        const mark = path.join(dir, 'hermes-started')
        const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
        const gatewayAnswers = source.match(/gateway_answers\(\) \{[\s\S]*?\n\}/)[0]
        const waitForGateway = source.match(/wait_for_gateway\(\) \{[\s\S]*?\n\}/)[0]
        let open = false
        const server = http.createServer((req, res) => {
            if (!open) {
                res.destroy()
                return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"ok":true}')
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        const opener = setTimeout(() => {
            open = true
            fs.writeFileSync(ready, String(Date.now()))
        }, 700)
        const script = `
set -euo pipefail
export CUTTLELY_HARNESS_GATEWAY_PORT=${port}
export CUTTLELY_GATEWAY_WAIT_SECONDS=8
NODE_BIN=${JSON.stringify(process.execPath)}
${gatewayAnswers}
${waitForGateway}
wait_for_gateway
"$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], String(Date.now()))' ${JSON.stringify(mark)}
`
        try {
            const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] })
            const code = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGTERM')
                    reject(new Error('gateway wait did not finish'))
                }, 12000)
                child.on('exit', (status) => {
                    clearTimeout(timer)
                    resolve(status)
                })
            })
            assert.equal(code, 0)
            const gatewayAt = Number(fs.readFileSync(ready, 'utf8'))
            const hermesAt = Number(fs.readFileSync(mark, 'utf8'))
            assert.ok(hermesAt >= gatewayAt)
        } finally {
            clearTimeout(opener)
            await new Promise((resolve) => server.close(resolve))
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('a gateway answering 503 while it compiles profiles is waited for past the usual limit', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-gateway-starting-'))
        const ready = path.join(dir, 'gateway-ready')
        const mark = path.join(dir, 'hermes-started')
        const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
        const gatewayAnswers = source.match(/gateway_answers\(\) \{[\s\S]*?\n\}/)[0]
        const waitForGateway = source.match(/wait_for_gateway\(\) \{[\s\S]*?\n\}/)[0]
        let open = false
        const server = http.createServer((req, res) => {
            res.writeHead(open ? 200 : 503, { 'content-type': 'application/json' })
            res.end(open ? '{"ok":true}' : '{"ok":false,"starting":true}')
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        // Past CUTTLELY_GATEWAY_WAIT_SECONDS=2: only the longer wait for a compiling gateway reaches it.
        const opener = setTimeout(() => {
            open = true
            fs.writeFileSync(ready, String(Date.now()))
        }, 3500)
        const script = `
set -euo pipefail
export CUTTLELY_HARNESS_GATEWAY_PORT=${port}
export CUTTLELY_GATEWAY_WAIT_SECONDS=2
export CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS=10
NODE_BIN=${JSON.stringify(process.execPath)}
${gatewayAnswers}
${waitForGateway}
wait_for_gateway
"$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], String(Date.now()))' ${JSON.stringify(mark)}
`
        try {
            const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] })
            let output = ''
            child.stdout.on('data', (chunk) => (output += chunk))
            const code = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGTERM')
                    reject(new Error('gateway wait did not finish'))
                }, 15000)
                child.on('exit', (status) => {
                    clearTimeout(timer)
                    resolve(status)
                })
            })
            assert.equal(code, 0, output)
            assert.match(output, /compiling agent profiles/)
            const gatewayAt = Number(fs.readFileSync(ready, 'utf8'))
            const hermesAt = Number(fs.readFileSync(mark, 'utf8'))
            assert.ok(hermesAt >= gatewayAt)
        } finally {
            clearTimeout(opener)
            await new Promise((resolve) => server.close(resolve))
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('misses during the warm-up grace do not restart Hermes', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-grace-'))
        const child = spawnSupervisor(dir, {
            CUTTLELY_HERMES_HEALTH_GRACE: '30',
            CUTTLELY_HERMES_HEALTH_WINDOW: '0',
            CUTTLELY_HERMES_HEALTH_FAILS: '1',
            health: 'fail-after-one'
        })
        try {
            await delay(4500)
            const status = readHermesStatus(dir)
            assert.equal(status?.state, 'up', child.output)
            assert.equal(status?.restarts, 0)
            assert.doesNotMatch(child.output, /Restart 1 of/)
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    it('a four second stall does not restart Hermes', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-stall-'))
        const child = spawnSupervisor(dir, {
            CUTTLELY_HERMES_HEALTH_GRACE: '0',
            CUTTLELY_HERMES_HEALTH_WINDOW: '15',
            CUTTLELY_HERMES_HEALTH_FAILS: '3',
            health: 'fail-after-one'
        })
        try {
            await delay(5000)
            const status = readHermesStatus(dir)
            assert.equal(status?.restarts, 0, child.output)
            assert.notEqual(status?.state, 'restarting')
            assert.doesNotMatch(child.output, /Restart 1 of/)
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    it('a sustained health outage restarts Hermes once', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-outage-'))
        const child = spawnSupervisor(dir, {
            CUTTLELY_HERMES_MAX_RESTARTS: '2',
            CUTTLELY_HERMES_HEALTH_GRACE: '0',
            CUTTLELY_HERMES_HEALTH_WINDOW: '2',
            CUTTLELY_HERMES_HEALTH_FAILS: '2',
            health: 'fail-then-recover'
        })
        try {
            const status = await waitForStatus(dir, (row) => row?.restarts === 1 && row?.state === 'up', child, 12000)
            assert.equal(status.restarts, 1)
            assert.equal(status.state, 'up')
            assert.match(child.output, /Restart 1 of 2/)
            assert.doesNotMatch(child.output, /Restart 2 of 2/)
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    it('an exit during the warm-up grace restarts right away', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-exit-grace-'))
        const started = Date.now()
        const child = spawnSupervisor(dir, {
            CUTTLELY_HERMES_MAX_RESTARTS: '1',
            CUTTLELY_HERMES_HEALTH_GRACE: '60',
            CUTTLELY_HERMES_HEALTH_WINDOW: '15',
            health: 'exit'
        })
        try {
            const code = await child.exited
            const elapsed = Date.now() - started
            assert.equal(code, 0, child.output)
            assert.match(child.output, /Restart 1 of 1/)
            assert.match(child.output, /exited with status 75/)
            assert.ok(elapsed < 8000, `exit restart waited ${elapsed}ms`)
            assert.equal(readHermesStatus(dir).state, 'down')
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    it('does not restart Hermes while a harness run is streaming', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-stream-'))
        const flag = path.join(dir, 'streaming')
        fs.writeFileSync(flag, '1')
        const check = path.join(dir, 'stream-check.sh')
        fs.writeFileSync(check, `#!/bin/sh\nif [ -f ${JSON.stringify(flag)} ]; then exit 0; fi\nexit 1\n`)
        fs.chmodSync(check, 0o755)
        const child = spawnSupervisor(dir, {
            CUTTLELY_HERMES_HEALTH_GRACE: '0',
            CUTTLELY_HERMES_HEALTH_WINDOW: '0',
            CUTTLELY_HERMES_HEALTH_FAILS: '1',
            CUTTLELY_HERMES_STREAM_CHECK: check,
            health: 'fail-after-one'
        })
        try {
            await delay(3000)
            assert.equal(readHermesStatus(dir)?.restarts, 0, child.output)
            assert.doesNotMatch(child.output, /Restart 1 of/)
            fs.rmSync(flag, { force: true })
            const status = await waitForStatus(dir, (row) => row?.state === 'restarting' || (row?.restarts || 0) > 0, child, 8000)
            assert.ok((status.restarts || 0) > 0 || status.state === 'restarting')
        } finally {
            await stopSupervisor(child, dir)
        }
    })
})

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function superviseSource() {
    return fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8').match(/supervise_hermes\(\) \{[\s\S]*?\n\}/)[0]
}

function spawnSupervisor(dir, options) {
    const health = options.health || 'fail-after-one'
    const healthBody =
        health === 'exit'
            ? `hermes_answers_health() { return 1; }
start_hermes_once() { "$NODE_BIN" -e 'process.exit(75)' & HERMES_PID=$!; }`
            : health === 'fail-then-recover'
            ? `hermes_answers_health() {
    n=$(cat "$PROBES")
    n=$((n + 1))
    echo "$n" > "$PROBES"
    if [[ -f "$DATA/recover" ]]; then
        return 0
    fi
    if [[ "$n" -eq 1 ]]; then
        return 0
    fi
    return 1
}
start_hermes_once() {
    "$NODE_BIN" -e '
        const fs = require("fs")
        const n = Number(fs.readFileSync(process.env.COUNT_FILE, "utf8") || "0") + 1
        fs.writeFileSync(process.env.COUNT_FILE, String(n))
        if (n > 1) fs.writeFileSync(process.env.RECOVER_FILE, "1")
        setInterval(() => {}, 1000)
    ' >/dev/null 2>&1 &
    HERMES_PID=$!
}`
            : `hermes_answers_health() {
    n=$(cat "$PROBES")
    n=$((n + 1))
    echo "$n" > "$PROBES"
    if [[ "$n" -eq 1 ]]; then
        return 0
    fi
    return 1
}
start_hermes_once() { "$NODE_BIN" -e 'setInterval(() => {}, 1000)' >/dev/null 2>&1 & HERMES_PID=$!; }`
    const script = `
set -euo pipefail
DATA=${JSON.stringify(dir)}
export CUTTLELY_DATA_DIR="$DATA"
export CUTTLELY_HERMES_MAX_RESTARTS=${options.CUTTLELY_HERMES_MAX_RESTARTS || '2'}
export CUTTLELY_HERMES_RESTART_DELAY=0
export CUTTLELY_HERMES_HEALTH_GRACE=${options.CUTTLELY_HERMES_HEALTH_GRACE ?? '60'}
export CUTTLELY_HERMES_HEALTH_WINDOW=${options.CUTTLELY_HERMES_HEALTH_WINDOW ?? '15'}
export CUTTLELY_HERMES_HEALTH_FAILS=${options.CUTTLELY_HERMES_HEALTH_FAILS || '3'}
${options.CUTTLELY_HERMES_STREAM_CHECK ? `export CUTTLELY_HERMES_STREAM_CHECK=${JSON.stringify(options.CUTTLELY_HERMES_STREAM_CHECK)}` : ''}
export PROBES="$DATA/probes"
export COUNT_FILE="$DATA/count"
export RECOVER_FILE="$DATA/recover"
echo 0 > "$PROBES"
echo 0 > "$COUNT_FILE"
HERMES_MAX_RESTARTS="$CUTTLELY_HERMES_MAX_RESTARTS"
ROOT=${JSON.stringify(ROOT)}
NODE_BIN=${JSON.stringify(process.execPath)}
HERMES_STOP="$DATA/hermes-supervisor.stop"
write_hermes_status() { "$NODE_BIN" "$ROOT/scripts/hermes-health.mjs" write "$1" "$2" "$3" "$4"; }
hermes_backoff_seconds() { echo "0"; }
kill_hermes_pid() { local pid="$1"; if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi; }
${healthBody}
${superviseSource()}
supervise_hermes
`
    const child = spawn('bash', ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const state = { output: '', exited: null }
    child.stdout.on('data', (chunk) => {
        state.output += chunk
    })
    child.stderr.on('data', (chunk) => {
        state.output += chunk
    })
    state.exited = new Promise((resolve) => {
        child.on('exit', (code) => resolve(code))
    })
    state.child = child
    return state
}

async function stopSupervisor(state, dir) {
    try {
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.stop'), '1')
    } catch {
        // The temp dir is already gone.
    }
    try {
        process.kill(-state.child.pid, 'SIGTERM')
    } catch {
        try {
            state.child.kill('SIGTERM')
        } catch {
            // Already gone.
        }
    }
    await Promise.race([state.exited, delay(2000)])
    state.child.stdout?.destroy()
    state.child.stderr?.destroy()
    state.child.unref()
    fs.rmSync(dir, { recursive: true, force: true })
}

async function waitForStatus(dir, ready, state, timeoutMs) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        const status = readHermesStatus(dir)
        if (ready(status)) return status
        await delay(100)
    }
    throw new Error(`status did not match\n${state.output}`)
}
