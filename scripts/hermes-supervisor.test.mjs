import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diagnosticLine, snapshotDescriptors } from './hermes-fd-snapshot.mjs'
import { pingForHermesStatus, readHermesStatus, writeHermesStatus } from './hermes-health.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Child Node helpers are application processes, not node:test workers.
const childEnv = { ...process.env }
delete childEnv.NODE_TEST_CONTEXT

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
${superviseSource()}
supervise_hermes
`
        try {
            const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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
            assert.equal(code, 70, combined)
            assert.match(combined, /Restart 1 of 2/)
            assert.match(combined, /Restart 2 of 2/)
            assert.match(combined, /restart limit 2 reached/)
            assert.match(combined, /exited with status 75/)
            assert.doesNotMatch(combined, /exited with status 127/)
            const status = readHermesStatus(dir)
            assert.equal(status.state, 'exhausted')
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
        const started = Number(process.hrtime.bigint() / 1000000n)
        const timer = setInterval(() => {
            let body = {}
            try { body = JSON.parse(fs.readFileSync(process.env.STATUS_FILE, "utf8")) } catch {}
            if (body.state === "restarting") {
                clearInterval(timer)
                setTimeout(() => process.exit(75), 200)
            }
            if (Number(process.hrtime.bigint() / 1000000n) - started > 8000) process.exit(9)
        }, 40)
    ' &
    HERMES_PID=$!
}
${superviseSource()}
supervise_hermes
`
        try {
            const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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
            assert.equal(code, 70, combined)
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
${superviseSource()}
supervise_hermes
`
        const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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
            fs.writeFileSync(ready, String(Number(process.hrtime.bigint() / 1000000n)))
        }, 700)
        const script = `
set -euo pipefail
export CUTTLELY_HARNESS_GATEWAY_PORT=${port}
export CUTTLELY_GATEWAY_WAIT_SECONDS=8
NODE_BIN=${JSON.stringify(process.execPath)}
${gatewayAnswers}
${waitForGateway}
wait_for_gateway
"$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], String(Number(process.hrtime.bigint() / 1000000n)))' ${JSON.stringify(mark)}
`
        try {
            const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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

    for (const mode of ['answers 503', 'is too busy to answer']) {
        it(`a gateway that ${mode} while it compiles profiles is waited for past the usual limit`, async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-gateway-starting-'))
            const ready = path.join(dir, 'gateway-ready')
            const mark = path.join(dir, 'hermes-started')
            const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
            const gatewayAnswers = source.match(/gateway_answers\(\) \{[\s\S]*?\n\}/)[0]
            const waitForGateway = source.match(/wait_for_gateway\(\) \{[\s\S]*?\n\}/)[0]
            let open = false
            const server = http.createServer((req, res) => {
                // Busy: the connection is accepted but nothing is written until the probe gives up.
                if (!open && mode !== 'answers 503') return
                res.writeHead(open ? 200 : 503, { 'content-type': 'application/json' })
                res.end(open ? '{"ok":true}' : '{"ok":false,"starting":true}')
            })
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
            const port = server.address().port
            // Past CUTTLELY_GATEWAY_WAIT_SECONDS=2: only the longer wait for a compiling gateway reaches it.
            const opener = setTimeout(() => {
                open = true
                fs.writeFileSync(ready, String(Number(process.hrtime.bigint() / 1000000n)))
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
"$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], String(Number(process.hrtime.bigint() / 1000000n)))' ${JSON.stringify(mark)}
`
            try {
                const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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
                server.closeAllConnections()
                await new Promise((resolve) => server.close(resolve))
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })
    }

    it('a gateway that stays compiling stops at the cap and says so', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-gateway-cap-'))
        const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
        const gatewayAnswers = source.match(/gateway_answers\(\) \{[\s\S]*?\n\}/)[0]
        const waitForGateway = source.match(/wait_for_gateway\(\) \{[\s\S]*?\n\}/)[0]
        const server = http.createServer((_req, res) => {
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end('{"ok":false,"starting":true}')
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        const script = `
set -euo pipefail
export CUTTLELY_HARNESS_GATEWAY_PORT=${port}
# Freeze the wall-clock command: the real wait must still honor its monotonic cap.
date() { printf '0\\n'; }
export CUTTLELY_GATEWAY_WAIT_SECONDS=1
export CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS=2
NODE_BIN=${JSON.stringify(process.execPath)}
${gatewayAnswers}
${waitForGateway}
wait_for_gateway
`
        const started = Number(process.hrtime.bigint() / 1000000n)
        try {
            const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
            let output = ''
            child.stdout.on('data', (chunk) => (output += chunk))
            child.stderr.on('data', (chunk) => (output += chunk))
            const code = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGTERM')
                    reject(new Error(`gateway cap wait did not finish\n${output}`))
                }, 10000)
                child.on('exit', (status) => {
                    clearTimeout(timer)
                    resolve(status)
                })
            })
            assert.notEqual(code, 0, output)
            assert.match(output, /still compiling agent profiles after \d+s \(cap 2s\)/)
            assert.ok(Number(process.hrtime.bigint() / 1000000n) - started < 8000, output)
        } finally {
            server.closeAllConnections?.()
            await new Promise((resolve) => server.close(resolve))
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('a longer gateway wait is still bounded by the compiling cap', async () => {
        const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
        const gatewayAnswers = source.match(/gateway_answers\(\) \{[\s\S]*?\n\}/)[0]
        const waitForGateway = source.match(/wait_for_gateway\(\) \{[\s\S]*?\n\}/)[0]
        const server = http.createServer((_req, res) => {
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end('{"ok":false,"starting":true}')
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        const script = `
set -euo pipefail
export CUTTLELY_HARNESS_GATEWAY_PORT=${port}
export CUTTLELY_GATEWAY_WAIT_SECONDS=30
export CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS=2
NODE_BIN=${JSON.stringify(process.execPath)}
${gatewayAnswers}
${waitForGateway}
wait_for_gateway
`
        const started = Number(process.hrtime.bigint() / 1000000n)
        try {
            const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
            let output = ''
            child.stdout.on('data', (chunk) => (output += chunk))
            child.stderr.on('data', (chunk) => (output += chunk))
            const code = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGTERM')
                    reject(new Error(`gateway cap wait did not finish\n${output}`))
                }, 10000)
                child.on('exit', (status) => {
                    clearTimeout(timer)
                    resolve(status)
                })
            })
            const elapsed = Number(process.hrtime.bigint() / 1000000n) - started
            assert.notEqual(code, 0, output)
            assert.match(output, /still compiling agent profiles after \d+s \(cap 2s\)/)
            assert.ok(elapsed < 8000, `${elapsed}\n${output}`)
        } finally {
            server.closeAllConnections?.()
            await new Promise((resolve) => server.close(resolve))
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

    it('a replacement runtime refuses agent calls until its first health answer', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-replacement-'))
        const { assertRuntimeAvailable } = await import('../packages/harness/availability.cjs')
        const child = spawnSupervisor(dir, {
            CUTTLELY_HERMES_MAX_RESTARTS: '3',
            CUTTLELY_HERMES_HEALTH_GRACE: '0',
            CUTTLELY_HERMES_HEALTH_WINDOW: '2',
            CUTTLELY_HERMES_HEALTH_FAILS: '2',
            health: 'replacement-slow'
        })
        try {
            await waitForStatus(dir, (row) => row?.restarts === 1, child, 15000)
            // The replacement is running but has not answered health yet.
            await delay(1500)
            const starting = readHermesStatus(dir)
            assert.equal(starting.state, 'restarting', child.output)
            assert.throws(
                () => assertRuntimeAvailable(dir),
                (error) => error.code === 'RUNTIME_UNAVAILABLE'
            )
            fs.writeFileSync(path.join(dir, 'replacement-ready'), '1')
            const up = await waitForStatus(dir, (row) => row?.state === 'up', child, 10000)
            assert.equal(up.restarts, 1)
            assert.doesNotThrow(() => assertRuntimeAvailable(dir))
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    it('an exit during the warm-up grace restarts right away', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-hermes-exit-grace-'))
        const started = Number(process.hrtime.bigint() / 1000000n)
        const child = spawnSupervisor(dir, {
            CUTTLELY_HERMES_MAX_RESTARTS: '1',
            CUTTLELY_HERMES_HEALTH_GRACE: '60',
            CUTTLELY_HERMES_HEALTH_WINDOW: '15',
            health: 'exit'
        })
        try {
            const code = await child.exited
            const elapsed = Number(process.hrtime.bigint() / 1000000n) - started
            assert.equal(code, 70, child.output)
            assert.match(child.output, /Restart 1 of 1/)
            assert.match(child.output, /exited with status 75/)
            assert.ok(elapsed < 8000, `exit restart waited ${elapsed}ms`)
            assert.equal(readHermesStatus(dir).state, 'exhausted')
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

describe('runtime containment recovery', () => {
    it('counts descriptor types and limits without exposing targets', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-fd-'))
        const base = path.join(dir, '42')
        fs.mkdirSync(path.join(base, 'fd'), { recursive: true })
        const regular = path.join(dir, 'private-profile-marker.db')
        fs.writeFileSync(regular, '')
        const targets = [regular, 'pipe:[42]', 'socket:[43]', 'anon_inode:[eventpoll]', dir]
        targets.forEach((target, index) => fs.symlinkSync(target, path.join(base, 'fd', String(index))))
        fs.writeFileSync(path.join(base, 'limits'), 'Max open files            4096                 8192                 files\n')
        try {
            assert.deepEqual(await snapshotDescriptors(42, dir), {
                total: 5,
                socket: 1,
                pipe: 1,
                anon_inode: 1,
                file: 1,
                other: 1,
                soft: '4096',
                hard: '8192'
            })
            const line = await diagnosticLine(
                { pid: 42, reason: 'health failures 3', burst: 2, budget: 5, lifetime: 8, action: 'restart' },
                dir
            )
            assert.match(line, /socket=1 pipe=1 anon_inode=1 file=1 other=1 soft=4096 hard=8192/)
            assert.doesNotMatch(line, /private-profile-marker|state.db|eventpoll|\//)
            assert.match(await diagnosticLine({ pid: 999 }, dir), /diagnostics unavailable/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('validates settings, caps cooldown and doubles fixed 2s backoff to its cap', () => {
        const result = spawnSync(
            'bash',
            [
                '-c',
                `set -euo pipefail
${superviseSource()}
export CUTTLELY_HERMES_MAX_RESTARTS=bad
export CUTTLELY_HERMES_HEALTHY_RESET_SECONDS=-1
export CUTTLELY_HERMES_RESTART_BACKOFF_MAX_SECONDS=5
export CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS=999999
configure_hermes_supervisor
for n in 1 2 3 4 500000; do hermes_backoff_seconds "$n"; done
printf '%s\\n' "$CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS"
`
            ],
            { encoding: 'utf8', env: { PATH: process.env.PATH } }
        )
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(result.stdout.trim().split('\n').map(Number), [2, 4, 5, 5, 5, 3600])
        assert.equal(result.stderr.trim().split('\n').length, 3)
        assert.match(result.stderr, /MAX_RESTARTS.*Using 5/)
        assert.match(result.stderr, /HEALTHY_RESET_SECONDS.*Using 600/)
    })

    it('resets a healthy burst while lifetime restarts keep growing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-reset-'))
        const child = recoverySupervisor(dir, {
            max: 1,
            reset: 1,
            child: `const fs = require('fs')
const file = process.env.CUTTLELY_DATA_DIR + '/launches'
const n = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1
fs.writeFileSync(file, String(n))
if (n === 1) process.exit(75)
if (n === 2) setTimeout(() => process.exit(75), 3400)
setInterval(() => {}, 1000)`
        })
        try {
            const status = await waitForStatus(dir, (row) => row?.state === 'up' && row?.lifetimeRestarts === 2, child, 9000)
            assert.equal(status.burstCount, 1)
            assert.equal(status.burstBudget, 1)
            assert.match(child.output, /burst reset from 1.*lifetime 1/)
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    it('opt-in exhaustion exits non-zero and keeps the final counters', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-exhaust-'))
        const child = recoverySupervisor(dir, { max: 1 })
        try {
            assert.equal(await child.exited, 70, child.output)
            const status = readHermesStatus(dir)
            assert.equal(status.state, 'exhausted')
            assert.equal(status.burstCount, 2)
            assert.equal(status.lifetimeRestarts, 2)
            assert.match(child.output, /action=exit/)
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    for (const mode of ['backoff', 'cooldown']) {
        it(`HERMES_STOP interrupts a long ${mode}`, async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-stop-wait-'))
            const child = recoverySupervisor(dir, { exit: false, max: mode === 'cooldown' ? 0 : 2, cooldown: 60, delay: 60 })
            try {
                await waitForStatus(dir, (row) => row?.state === (mode === 'cooldown' ? 'cooldown' : 'restarting'), child, 5000)
                const started = performance.now()
                fs.writeFileSync(path.join(dir, 'hermes-supervisor.stop'), '1')
                assert.equal(await child.exited, 0)
                assert.ok(performance.now() - started < 1000)
            } finally {
                await stopSupervisor(child, dir)
            }
        })
    }

    it('logs count-only diagnostics before killing an unhealthy child', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-prekill-'))
        const child = recoverySupervisor(dir, {
            max: 0,
            health: 'health_calls=$((health_calls + 1)); [[ "$health_calls" -eq 1 ]]',
            child: `const fs = require('fs')
fs.openSync(process.env.CUTTLELY_DATA_DIR + '/private-profile-marker.db', 'w')
process.on('SIGTERM', () => { console.error('child received TERM'); process.exit(0) })
setInterval(() => {}, 1000)`
        })
        try {
            assert.equal(await child.exited, 70, child.output)
            assert.match(child.output, /reason=health failures 1.*total=\d+.*file=\d+.*soft=\d+ hard=\d+/)
            assert.ok(child.output.indexOf('Hermes diagnostics') < child.output.indexOf('child received TERM'), child.output)
            assert.doesNotMatch(child.output, /private-profile-marker|cuttlely-prekill-/)
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    it('the outer loop restarts both processes in place and limits only the recovery compile window', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-stack-nosocket-'))
        const child = stackSupervisor(dir, false, false)
        try {
            await waitForStatus(dir, (row) => row?.state === 'cooldown', child, 5000)
            const status = await waitForStatus(
                dir,
                (row) => row?.state === 'up' && fs.readFileSync(path.join(dir, 'servers'), 'utf8') === '2',
                child,
                6000
            )
            assert.equal(status.burstCount, 0)
            assert.equal(status.lifetimeRestarts, 1)
            assert.equal(fs.readFileSync(path.join(dir, 'caps'), 'utf8'), 'default\n10\n')
            assert.equal(child.child.exitCode, null)
            assert.match(child.output, /Hermes diagnostics.*action=cooldown/)
        } finally {
            await stopSupervisor(child, dir)
        }
    })

    for (const exit of [false, true]) {
        it(
            exit
                ? 'opt-in exit drains Node and the outer loop propagates 70'
                : 'default exhaustion keeps liveness green during cooldown and restarts the whole stack without exiting',
            async () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-stack-'))
                const child = stackSupervisor(dir, exit)
                try {
                    if (exit) {
                        assert.equal(await child.exited, 70, child.output)
                        assert.match(child.output, /node drained/)
                        assert.equal(fs.readFileSync(path.join(dir, 'servers'), 'utf8'), '1')
                        return
                    }
                    await waitForStatus(dir, (row) => row?.state === 'cooldown', child, 5000)
                    const cooldownStarted = performance.now()
                    const port = Number(fs.readFileSync(path.join(dir, 'port'), 'utf8'))
                    for (let i = 0; i < 4; i++) {
                        assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/ping/live`)).status, 200)
                        assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/ping`)).status, 503)
                        await delay(100)
                    }
                    assert.equal(readHermesStatus(dir).state, 'cooldown', child.output)
                    // Poll liveness through the whole-stack restart. Docker's --start-period does not apply again, so the
                    // gap while no server listens must stay well under the image's interval x retries (15s x 20).
                    const probeBudgetMs = 15_000 * 20
                    let gapStart = null
                    let longestGap = 0
                    let sawSecondServer = false
                    while (performance.now() - cooldownStarted < 8000) {
                        const second = fs.readFileSync(path.join(dir, 'servers'), 'utf8') === '2'
                        let ok = false
                        try {
                            const livePort = Number(fs.readFileSync(path.join(dir, 'port'), 'utf8'))
                            ok = (await fetch(`http://127.0.0.1:${livePort}/api/v1/ping/live`)).status === 200
                        } catch {
                            ok = false
                        }
                        if (!ok && gapStart === null) gapStart = performance.now()
                        if (ok && gapStart !== null) {
                            longestGap = Math.max(longestGap, performance.now() - gapStart)
                            gapStart = null
                        }
                        if (ok && second) {
                            sawSecondServer = true
                            break
                        }
                        await delay(25)
                    }
                    assert.ok(sawSecondServer, child.output)
                    assert.equal(gapStart, null)
                    assert.ok(longestGap < probeBudgetMs, `gateway-down gap ${longestGap}ms`)
                    // Right after the restart in place: live answers while readiness is still refusing traffic.
                    const restartedPort = Number(fs.readFileSync(path.join(dir, 'port'), 'utf8'))
                    assert.equal((await fetch(`http://127.0.0.1:${restartedPort}/api/v1/ping/live`)).status, 200)
                    assert.equal((await fetch(`http://127.0.0.1:${restartedPort}/api/v1/ping`)).status, 503)
                    assert.equal(fs.readFileSync(path.join(dir, 'restarted'), 'utf8'), 'first\n1\n')
                    const status = await waitForStatus(
                        dir,
                        (row) => row?.state === 'up' && fs.readFileSync(path.join(dir, 'servers'), 'utf8') === '2',
                        child,
                        6000
                    )
                    assert.ok(performance.now() - cooldownStarted >= 650, child.output)
                    assert.equal(status.burstCount, 0)
                    assert.equal(status.lifetimeRestarts, 1)
                    assert.equal(fs.readFileSync(path.join(dir, 'caps'), 'utf8'), 'default\n10\n')
                    assert.equal(child.child.exitCode, null)
                    assert.match(child.output, /Hermes diagnostics.*action=cooldown/)
                    assert.match(child.output, /node drained/)
                } finally {
                    await stopSupervisor(child, dir)
                }
            }
        )
    }
})

function recoverySupervisor(
    dir,
    {
        exit = true,
        max = 2,
        reset = 600,
        cooldown = 300,
        delay: restartDelay = 0,
        child: childCode = 'process.exit(75)',
        health = 'return 0'
    } = {}
) {
    const script = `set -euo pipefail
DATA=${JSON.stringify(dir)}
export CUTTLELY_DATA_DIR="$DATA"
ROOT=${JSON.stringify(ROOT)}
NODE_BIN=${JSON.stringify(process.execPath)}
HERMES_STOP="$DATA/hermes-supervisor.stop"
export CUTTLELY_EXIT_ON_EXHAUSTED=${exit ? 1 : 0}
export CUTTLELY_HERMES_MAX_RESTARTS=${max}
export CUTTLELY_HERMES_HEALTHY_RESET_SECONDS=${reset}
export CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS=${cooldown}
export CUTTLELY_HERMES_RESTART_DELAY=${restartDelay}
export CUTTLELY_HERMES_HEALTH_GRACE=0
export CUTTLELY_HERMES_HEALTH_WINDOW=0
export CUTTLELY_HERMES_HEALTH_FAILS=1
health_calls=0
hermes_answers_health() { ${health}; }
start_hermes_once() { "$NODE_BIN" -e ${shellQuote(childCode)} & HERMES_PID=$!; }
${superviseSource()}
supervise_hermes
`
    return spawnScript(script)
}

function stackSupervisor(dir, exit, withHttp = !exit) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
    const outer = source.slice(source.indexOf('# Restart in place.'), source.indexOf('\nfi\n') + 4)
    const cleanup = source.match(/cleanup\(\) \{[\s\S]*?\n\}/)[0]
    const server = `const fs = require('fs'); const http = require('http')
const dir = process.env.CUTTLELY_DATA_DIR
const file = dir + '/servers'
fs.writeFileSync(file, String(Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1))
fs.appendFileSync(dir + '/caps', String(process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS || 'default') + '\\n')
fs.appendFileSync(dir + '/restarted', String(process.env.CUTTLELY_STACK_RESTARTED || 'first') + '\\n')
${
    withHttp
        ? `const server = http.createServer((req, res) => { res.statusCode = req.url.endsWith('/live') ? 200 : 503; res.end('pong') })
server.listen(0, '127.0.0.1', () => fs.writeFileSync(dir + '/port', String(server.address().port)))
process.on('SIGTERM', () => { console.log('node drained'); server.close(() => process.exit(0)) })`
        : `setInterval(() => {}, 1000)
process.on('SIGTERM', () => { console.log('node drained'); process.exit(0) })`
}`
    const runtime = `const fs = require('fs'); const dir = process.env.CUTTLELY_DATA_DIR
if (!fs.existsSync(dir + '/failed')) { fs.writeFileSync(dir + '/failed', '1'); process.exit(75) }
setInterval(() => {}, 1000)`
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.writeFileSync(
        path.join(dir, 'scripts/start-cuttlely.sh'),
        `set -euo pipefail
DATA=${shellQuote(dir)}
ROOT=${shellQuote(ROOT)}
export CUTTLELY_DATA_DIR="$DATA"
NODE_BIN=${shellQuote(process.execPath)}
HERMES_STOP="$DATA/hermes-supervisor.stop"
rm -f "$HERMES_STOP"
HERMES_PARENT_PID=$$
WORKER_PIDS=()
${superviseSource()}
${cleanup}
trap cleanup EXIT
trap 'HERMES_RECOVERY_RESTART=1; exit 75' USR1
trap 'exit 70' USR2
trap 'exit 143' TERM
export CUTTLELY_EXIT_ON_EXHAUSTED=${exit ? 1 : 0}
export CUTTLELY_HERMES_MAX_RESTARTS=0
export CUTTLELY_HERMES_EXHAUSTED_COOLDOWN_SECONDS=0.8
hermes_answers_health() { return 0; }
start_hermes_once() { "$NODE_BIN" -e ${shellQuote(runtime)} & HERMES_PID=$!; }
"$NODE_BIN" -e ${shellQuote(server)} &
CUTTLELY_PID=$!
supervise_hermes &
HERMES_SUPERVISOR_PID=$!
wait "$CUTTLELY_PID"
`
    )
    return spawnScript(`set -euo pipefail\nROOT=${shellQuote(dir)}\nexport CUTTLELY_DATA_DIR=${shellQuote(dir)}\n${outer}`)
}

function spawnScript(script) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-supervisor-output-'))
    const outputPath = path.join(outputDir, 'output')
    const outputFd = fs.openSync(outputPath, 'w')
    const child = spawn('bash', ['-c', script], { env: childEnv, stdio: ['ignore', outputFd, outputFd], detached: true })
    fs.closeSync(outputFd)
    const state = {
        child,
        outputDir,
        get output() {
            return fs.readFileSync(outputPath, 'utf8')
        },
        exited: null
    }
    state.exited = new Promise((resolve) => child.on('exit', resolve))
    return state
}

function shellQuote(value) {
    return "'" + value.replaceAll("'", "'\\''") + "'"
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function superviseSource() {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
    const names = [
        'hermes_number',
        'configure_hermes_supervisor',
        'write_hermes_status',
        'hermes_backoff_seconds',
        'hermes_pause',
        'hermes_clock',
        'hermes_diagnostics',
        'kill_hermes_pid',
        'hermes_final_escalation',
        'supervise_hermes'
    ]
    return (
        'export CUTTLELY_EXIT_ON_EXHAUSTED="${CUTTLELY_EXIT_ON_EXHAUSTED:-1}"\n' +
        names.map((name) => source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]).join('\n')
    )
}

function spawnSupervisor(dir, options) {
    const health = options.health || 'fail-after-one'
    const healthBody =
        health === 'replacement-slow'
            ? `hermes_answers_health() {
    n=$(cat "$PROBES")
    n=$((n + 1))
    echo "$n" > "$PROBES"
    if [[ "$n" -eq 1 || -f "$DATA/replacement-ready" ]]; then
        return 0
    fi
    return 1
}
start_hermes_once() { "$NODE_BIN" -e 'setInterval(() => {}, 1000)' >/dev/null 2>&1 & HERMES_PID=$!; }`
            : health === 'exit'
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
${Object.entries(options)
    .filter(([name]) => name.startsWith('CUTTLELY_'))
    .map(([name, value]) => `export ${name}=${JSON.stringify(String(value))}`)
    .join('\n')}
${healthBody}
${superviseSource()}
supervise_hermes
`
    const child = spawn('bash', ['-lc', script], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
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
    if (state.outputDir) fs.rmSync(state.outputDir, { recursive: true, force: true })
}

async function waitForStatus(dir, ready, state, timeoutMs) {
    const started = Number(process.hrtime.bigint() / 1000000n)
    while (Number(process.hrtime.bigint() / 1000000n) - started < timeoutMs) {
        const status = readHermesStatus(dir)
        if (ready(status)) return status
        await delay(100)
    }
    throw new Error(`status did not match\n${state.output}`)
}

// The boot branch after the gateway wait, run with a gateway that answers only after the short recovery cap.
function gatewayBootBranch(dir, restarted) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
    const pick = (name) => source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]
    const start = source.indexOf('if ! wait_for_gateway; then')
    const end = source.indexOf('\nif [[ "${CUTTLELY_HARNESS_QUEUE:-inline}" == "external" ]]; then', start)
    assert.ok(start > 0 && end > start, 'boot branch found in start-cuttlely.sh')
    const script = `set -uo pipefail
DATA=${shellQuote(dir)}
NODE_BIN=${shellQuote(process.execPath)}
HERMES_STOP="$DATA/stop"
${restarted ? 'export CUTTLELY_STACK_RESTARTED=1' : 'unset CUTTLELY_STACK_RESTARTED'}
export CUTTLELY_GATEWAY_WAIT_SECONDS=1 CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS=1
gateway_answers() { [[ -f "$DATA/listening" ]]; }
write_hermes_status() { echo "$1" > "$DATA/status"; }
supervise_hermes() { echo supervised > "$DATA/supervised"; }
${pick('wait_for_gateway')}
${pick('start_hermes_when_gateway_ready')}
sleep 30 &
CUTTLELY_PID=$!
${source.slice(start, end)}
wait "$HERMES_SUPERVISOR_PID" 2>/dev/null
kill "$CUTTLELY_PID" 2>/dev/null
`
    return spawnScript(script)
}

describe('recovery restart with a slow server start', () => {
    it('keeps waiting for the gateway after a restart in place instead of leaving the runtime down', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-slow-start-'))
        const run = gatewayBootBranch(dir, true)
        try {
            // The server listens only after the short recovery cap has passed.
            await delay(2500)
            assert.equal(fs.existsSync(path.join(dir, 'status')), false, 'runtime not recorded as down')
            fs.writeFileSync(path.join(dir, 'listening'), '1')
            const deadline = Date.now() + 8000
            while (!fs.existsSync(path.join(dir, 'supervised')) && Date.now() < deadline) await delay(100)
            assert.equal(fs.existsSync(path.join(dir, 'supervised')), true, run.output)
            await run.exited
        } finally {
            try {
                process.kill(-run.child.pid, 'SIGKILL')
            } catch {
                /* already exited */
            }
            fs.rmSync(dir, { recursive: true, force: true })
            fs.rmSync(run.outputDir, { recursive: true, force: true })
        }
    })

    it('on first boot a gateway that never answered is still recorded as down', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-slow-start-'))
        const run = gatewayBootBranch(dir, false)
        try {
            await run.exited
            assert.equal(fs.readFileSync(path.join(dir, 'status'), 'utf8').trim(), 'down', run.output)
            assert.equal(fs.existsSync(path.join(dir, 'supervised')), false)
        } finally {
            try {
                process.kill(-run.child.pid, 'SIGKILL')
            } catch {
                /* already exited */
            }
            fs.rmSync(dir, { recursive: true, force: true })
            fs.rmSync(run.outputDir, { recursive: true, force: true })
        }
    })
})
