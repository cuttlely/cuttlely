// Restart in place: the outer copy of scripts/start-cuttlely.sh starts a fresh inner copy when it exits with 75 (restart)
// or 76 (could not start with changed server settings).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = fs.readFileSync(path.join(ROOT, 'scripts', 'start-cuttlely.sh'), 'utf8')
const start = script.indexOf('# Restart in place.')
const end = script.indexOf('\nfi\n', start) + 4
const block = script.slice(start, end)

function fakeRoot(inner) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-loop-'))
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.writeFileSync(path.join(root, 'scripts', 'start-cuttlely.sh'), inner)
    return root
}

function outer(root) {
    return `set -euo pipefail\nROOT=${JSON.stringify(root)}\n${block}\necho "outer fell through"\n`
}

test('the loop is at the top of the start script', () => {
    assert.ok(start > 0 && start < script.indexOf('DATA="${CUTTLELY_DATA_DIR'))
    assert.ok(block.includes('-ne 75') && block.includes('-ne 76'))
})

test('exit 75 starts a fresh inner copy; anything else ends the loop', () => {
    const root = fakeRoot(`
n=$(cat "$ROOT_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$ROOT_COUNT"
echo "run $n supervised=$CUTTLELY_SUPERVISED inner=$CUTTLELY_START_INNER leaked=\${LEAKED:-none}"
export LEAKED=yes
if [ "$n" -lt 3 ]; then exit 75; fi
exit 0
`)
    const result = spawnSync('bash', ['-c', outer(root)], {
        env: { PATH: process.env.PATH, ROOT_COUNT: path.join(root, 'count') },
        encoding: 'utf8'
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /run 1 supervised=1 inner=1 leaked=none/)
    assert.match(result.stdout, /run 3 supervised=1 inner=1 leaked=none/)
    assert.equal(result.stdout.match(/Restarting Cuttlely to apply server settings\./g)?.length, 2)
    assert.doesNotMatch(result.stdout, /outer fell through/)
})

test('exit 76 (could not start with changed settings) starts again so safe boot can count it', () => {
    const root = fakeRoot(`
n=$(cat "$ROOT_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$ROOT_COUNT"
echo "run $n"
if [ "$n" -lt 3 ]; then exit 76; fi
exit 0
`)
    const result = spawnSync('bash', ['-c', outer(root)], {
        env: { PATH: process.env.PATH, ROOT_COUNT: path.join(root, 'count') },
        encoding: 'utf8'
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /run 3/)
    assert.equal(result.stdout.match(/could not start with the saved server settings/g)?.length, 2)
    assert.doesNotMatch(result.stdout, /Restarting Cuttlely to apply/)
})

test('a failing start ends with its own status', () => {
    const root = fakeRoot('exit 3\n')
    const result = spawnSync('bash', ['-c', outer(root)], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
    assert.equal(result.status, 3)
    assert.doesNotMatch(result.stdout, /Restarting/)
})

test('a stop signal reaches the inner copy and is never taken as a restart', async () => {
    const root = fakeRoot(`trap 'exit 75' TERM\necho ready\nwhile true; do sleep 0.1; done\n`)
    const child = spawn('bash', ['-c', outer(root)], { env: { PATH: process.env.PATH } })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    await new Promise((resolve) => {
        const check = setInterval(() => {
            if (out.includes('ready')) {
                clearInterval(check)
                resolve()
            }
        }, 50)
    })
    child.kill('SIGTERM')
    const code = await new Promise((resolve) => child.on('exit', (status) => resolve(status)))
    assert.equal(code, 75)
    assert.doesNotMatch(out, /Restarting/)
})

test('on stop, the inner copy waits for Cuttlely to finish open requests before it stops Hermes', () => {
    const from = script.indexOf('\ncleanup() {')
    const to = script.indexOf('\n}\n', from) + 3
    const cleanup = script.slice(from, to)
    assert.ok(from > 0 && cleanup.includes('wait "$CUTTLELY_PID"'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-stop-'))
    const log = path.join(dir, 'order.log')
    const result = spawnSync(
        'bash',
        [
            '-c',
            `set -euo pipefail
DATA=${JSON.stringify(dir)}
HERMES_STOP="$DATA/hermes-supervisor.stop"
WORKER_PIDS=()
HERMES_PID=12345
kill_hermes_pid() { [[ -f "$HERMES_STOP" ]] && echo hermes stopped >> ${JSON.stringify(log)}; }
# A stand-in for the server: on SIGTERM it takes a moment to finish its open requests, then exits.
bash -c 'trap "sleep 1; echo server drained >> ${log}; exit 0" TERM; while true; do sleep 0.1; done' &
CUTTLELY_PID=$!
sleep 0.3
${cleanup}
cleanup
`
        ],
        { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['server drained', 'hermes stopped'])
})
