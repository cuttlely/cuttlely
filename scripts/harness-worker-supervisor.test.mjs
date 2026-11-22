import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(ROOT, 'scripts/start-cuttlely.sh'), 'utf8')
const pick = (name) => source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function rows(dir, name) {
    try {
        return fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    } catch {
        return []
    }
}

function alive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

function groupPids(pid) {
    const result = spawnSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([, group]) => group === pid)
        .map(([child]) => child)
}

async function waitFor(run, ready, timeout = 10000) {
    const deadline = performance.now() + timeout
    while (performance.now() < deadline) {
        if (ready()) return
        await delay(25)
    }
    assert.fail(`condition did not match\n${run.output}`)
}

function stack(dir) {
    const outer = source.slice(source.indexOf('# Restart in place.'), source.indexOf('\nfi\n') + 4)
    const workers = source.slice(source.indexOf('if [[ "${CUTTLELY_HARNESS_QUEUE:-inline}" == "external" ]]; then'))
    const traps = source.slice(source.indexOf('trap cleanup EXIT'), source.indexOf('\necho "Cuttlely boot, step 1'))
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.mkdirSync(path.join(dir, 'packages/harness'), { recursive: true })
    fs.writeFileSync(
        path.join(dir, 'packages/harness/worker.mjs'),
        `
import fs from 'node:fs'
const dir = process.env.CUTTLELY_DATA_DIR
process.on('SIGTERM', () => fs.appendFileSync(dir + '/terms', JSON.stringify(process.pid) + '\\n'))
fs.appendFileSync(dir + '/workers', JSON.stringify({ pid: process.pid, parent: process.ppid, generation: Number(process.env.GENERATION) }) + '\\n')
setInterval(() => {}, 1000)
`
    )
    fs.writeFileSync(
        path.join(dir, 'server.mjs'),
        `
import fs from 'node:fs'
const dir = process.env.CUTTLELY_DATA_DIR
setInterval(() => {
    if (!fs.existsSync(dir + '/restart')) return
    const code = Number(fs.readFileSync(dir + '/restart', 'utf8'))
    fs.unlinkSync(dir + '/restart')
    process.exit(code)
}, 25)
`
    )
    fs.writeFileSync(
        path.join(dir, 'scripts/start-cuttlely.sh'),
        `set -euo pipefail
DATA="$CUTTLELY_DATA_DIR"
HERMES_STOP="$DATA/hermes-supervisor.stop"
rm -f "$HERMES_STOP"
generation=0
if [[ -f "$DATA/generation" ]]; then read -r generation < "$DATA/generation"; fi
export GENERATION=$((generation + 1))
echo "$GENERATION" > "$DATA/generation"
echo "$$" > "$DATA/inner-pid"
WORKER_PIDS=()
NODE_CMD=("$NODE_BIN")
${pick('hermes_clock')}
${pick('stop_worker_pids')}
${pick('cleanup')}
${traps}
"$NODE_BIN" "$DATA/server.mjs" &
CUTTLELY_PID=$!
${workers}
`
    )
    const log = path.join(dir, 'output')
    const fd = fs.openSync(log, 'w')
    const child = spawn('bash', ['-c', `set -euo pipefail\n${outer}`], {
        env: {
            PATH: process.env.PATH,
            ROOT: dir,
            NODE_BIN: process.execPath,
            HOME: dir,
            DATABASE_PATH: dir,
            CUTTLELY_DATA_DIR: dir,
            HERMES_HOME: path.join(dir, 'hermes'),
            CUTTLELY_HERMES_HOME: path.join(dir, 'hermes'),
            CUTTLELY_HARNESS_QUEUE: 'external',
            CUTTLELY_HARNESS_WORKERS: '2'
        },
        stdio: ['ignore', fd, fd],
        detached: true
    })
    fs.closeSync(fd)
    return {
        child,
        exited: new Promise((resolve) => child.on('exit', resolve)),
        get output() {
            return fs.readFileSync(log, 'utf8')
        }
    }
}

async function dispose(run, dir) {
    try {
        if (run.child.exitCode === null) {
            run.child.kill('SIGTERM')
            await Promise.race([run.exited, delay(8000)])
        }
    } finally {
        try {
            process.kill(-run.child.pid, 'SIGKILL')
        } catch {
            /* already gone */
        }
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

describe('external harness worker supervisor', () => {
    for (const restart of [75, 76, 'recovery']) {
        it(`reaps TERM-resistant workers before the next iteration after ${restart}`, async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-workers-'))
            const run = stack(dir)
            try {
                await waitFor(run, () => rows(dir, 'workers').length === 2)
                const first = rows(dir, 'workers')
                if (restart === 'recovery') {
                    process.kill(Number(fs.readFileSync(path.join(dir, 'inner-pid'), 'utf8')), 'SIGUSR1')
                } else {
                    fs.writeFileSync(path.join(dir, 'restart'), String(restart))
                }
                await waitFor(run, () => rows(dir, 'workers').length === 4)
                assert.deepEqual(rows(dir, 'terms').sort(), first.map(({ pid }) => pid).sort(), 'both workers received TERM')
                assert.deepEqual(
                    first.filter(({ pid }) => alive(pid)),
                    [],
                    'zero old workers, including zombies'
                )
                assert.equal(rows(dir, 'workers').filter(({ pid }) => alive(pid)).length, 2, 'only expected workers live')
                assert.ok(
                    first.every(({ parent }) => !alive(parent)),
                    'old parents reaped'
                )
                run.child.kill('SIGTERM')
                assert.equal(await run.exited, 143, run.output)
                assert.deepEqual(groupPids(run.child.pid), [], 'shutdown leaves zero processes')
            } finally {
                await dispose(run, dir)
            }
        })
    }
})
