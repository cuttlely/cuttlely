// Real Cuttlely entrypoint, real signals, and the durable ledger across restarts. No model calls.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENV_PYTHON = path.join(ROOT, 'hermes', '.venv', 'bin', 'python')
const PYTHON = process.env.HERMES_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3')
const available = spawnSync(PYTHON, ['-c', 'import aiohttp, mcp']).status === 0
if (!available && (process.env.CUTTLELY_REQUIRE_HERMES_RUNTIME === '1' || process.env.HERMES_PYTHON || fs.existsSync(VENV_PYTHON))) {
    assert.fail('The configured Hermes Python must import aiohttp and mcp; repair the runtime instead of skipping lifecycle tests.')
}

async function waitFor(check, diagnostics) {
    const deadline = Date.now() + 29_000
    while (Date.now() < deadline) {
        if (await check()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.fail(`Timed out: ${diagnostics()}`)
}

async function fixture(t, multiplex) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-lifecycle-'))
    const home = path.join(directory, 'hermes')
    fs.mkdirSync(home, { recursive: true })
    // With no explicit flag and only one profile, Hermes selects single-profile mode.
    // An explicit false is retired and can silently enable multiplexing instead.
    const config = {
        gateway: multiplex ? { multiplex_profiles: true } : {},
        model_catalog: { enabled: false },
        security: { tirith_enabled: false }
    }
    fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify(config))
    if (multiplex) {
        fs.mkdirSync(path.join(home, 'profiles', 'secondary'), { recursive: true })
        fs.writeFileSync(path.join(home, 'profiles', 'secondary', 'config.yaml'), JSON.stringify(config))
    }
    const socket = net.createServer()
    socket.listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const port = socket.address().port
    await new Promise((resolve) => socket.close(resolve))
    const sentinel = () => JSON.parse(fs.readFileSync(path.join(home, 'state', 'gateway.lifecycle.json'), 'utf8'))
    const logs = () => {
        let result = ''
        for (const base of [home, path.join(home, 'profiles', 'secondary')]) {
            for (const name of ['gateway.log', 'errors.log', 'gateway-exit-diag.log']) {
                try {
                    result += fs.readFileSync(path.join(base, 'logs', name), 'utf8')
                } catch {
                    /* The runtime creates each log only when needed. */
                }
            }
        }
        return result
    }
    const stops = []
    t.after(async () => {
        for (const stop of stops) await stop()
        fs.rmSync(directory, { recursive: true, force: true })
    })
    return {
        sentinel,
        logs,
        async boot() {
            let output = ''
            const child = spawn(PYTHON, ['-u', path.join(ROOT, 'scripts', 'cuttlely-hermes-api.py')], {
                cwd: ROOT,
                env: {
                    ...process.env,
                    HOME: directory,
                    DATABASE_PATH: directory,
                    SECRETKEY_PATH: directory,
                    BLOB_STORAGE_PATH: directory,
                    CUTTLELY_DATA_DIR: directory,
                    LOG_PATH: directory,
                    HERMES_HOME: home,
                    HERMES_RUNTIME_DIR: path.join(directory, 'runtime'),
                    API_SERVER_PORT: String(port),
                    CUTTLELY_PRELOAD_HERMES: 'true',
                    PYTHONDONTWRITEBYTECODE: '1'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            })
            child.stdout.on('data', (data) => (output += data))
            child.stderr.on('data', (data) => (output += data))
            const closed = once(child, 'close')
            const stop = async (signal = 'SIGTERM', repeat = false) => {
                if (child.exitCode !== null || child.signalCode !== null) return closed
                child.kill(signal)
                const repeated = repeat ? setTimeout(() => child.kill(signal), 100) : undefined
                const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
                try {
                    return await closed
                } finally {
                    clearTimeout(timer)
                    clearTimeout(repeated)
                }
            }
            stops.push(stop)
            await waitFor(
                async () => {
                    assert.equal(child.exitCode, null, output)
                    assert.equal(child.signalCode, null, output)
                    try {
                        return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok
                    } catch {
                        return false
                    }
                },
                () => output + logs()
            )
            const running = sentinel()
            assert.equal(running.phase, 'running')
            assert.equal(running.pid, child.pid, 'the supervised PID is the Python ledger owner')
            return { stop, output: () => output }
        }
    }
}

const skip = available ? false : 'Hermes Python with aiohttp and mcp is required for the live lifecycle tests'

test('SIGTERM completes teardown and leaves a clean ledger on restart, with and without multiplex profiles', { skip }, async (t) => {
    for (const multiplex of [false, true]) {
        const runtime = await fixture(t, multiplex)
        const first = await runtime.boot()
        // A second stop signal during teardown must still leave one clean life.
        const started = Date.now()
        const [code, signal] = await first.stop('SIGTERM', multiplex)
        assert.equal(signal, null, first.output())
        assert.equal(code, 0, 'SIGTERM keeps the legacy launcher exit code: ' + first.output())
        t.diagnostic(`multiplex=${multiplex}: SIGTERM exit ${code}`)
        const exited = runtime.sentinel()
        assert.equal(exited.phase, 'exited', first.output() + runtime.logs())
        assert.equal(exited.exit_code, code)
        assert.equal(exited.exit_reason, 'graceful_shutdown')
        t.diagnostic(`multiplex=${multiplex}: SIGTERM stop ${Date.now() - started} ms, clean ledger (exit ${code})`)
        const second = await runtime.boot()
        assert.equal(runtime.sentinel().prior_unclean_exit, undefined)
        assert.doesNotMatch(first.output() + second.output() + runtime.logs(), /exited UNCLEANLY|gateway.previous_unclean_exit/)
        const [restartCode, restartSignal] = await second.stop()
        assert.equal(restartSignal, null, second.output())
        assert.equal(restartCode, 0, second.output())
        assert.equal(runtime.sentinel().phase, 'exited')
    }
})

test('SIGKILL leaves evidence and the next boot reports the previous life as unclean', { skip }, async (t) => {
    const runtime = await fixture(t, true)
    const first = await runtime.boot()
    const [, signal] = await first.stop('SIGKILL')
    assert.equal(signal, 'SIGKILL')
    assert.equal(runtime.sentinel().phase, 'running')
    const second = await runtime.boot()
    assert.equal(runtime.sentinel().prior_unclean_exit, true)
    await waitFor(
        () => /exited UNCLEANLY/.test(second.output() + runtime.logs()),
        () => second.output() + runtime.logs()
    )
    const [restartCode, restartSignal] = await second.stop()
    assert.equal(restartSignal, null, second.output())
    assert.equal(restartCode, 0, second.output())
    assert.equal(runtime.sentinel().phase, 'exited')
})
