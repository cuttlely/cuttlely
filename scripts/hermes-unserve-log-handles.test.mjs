import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(ROOT, 'hermes')
const probe = path.join(ROOT, 'scripts', 'fixtures', 'unserve-log-handles-probe.py')
const python = [process.env.HERMES_PYTHON, path.join(runtime, '.venv/bin/python'), 'python3']
    .filter(Boolean)
    .find(
        (command) =>
            spawnSync(
                command,
                ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import hermes_logging, gateway.run_profile_reconcile', runtime],
                { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30_000 }
            ).status === 0
    )

test(
    'unserving a multiplexed profile closes its log and MCP stderr fds and leaves a sibling served',
    {
        skip:
            process.platform !== 'linux'
                ? 'fd accounting uses /proc/self/fd'
                : !python && process.env.CUTTLELY_REQUIRE_HERMES_RUNTIME !== '1'
                ? 'runtime Python dependencies unavailable'
                : false
    },
    () => {
        assert(python, 'Runtime Python dependencies are required')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-unserve-logs-'))
        const home = path.join(dir, 'home')
        const hermesHome = path.join(dir, 'hermes')
        fs.mkdirSync(home, { recursive: true })
        fs.mkdirSync(hermesHome, { recursive: true })
        try {
            const result = spawnSync(python, [probe, runtime], {
                encoding: 'utf8',
                timeout: 60_000,
                env: {
                    ...process.env,
                    PYTHONDONTWRITEBYTECODE: '1',
                    HOME: home,
                    HERMES_HOME: hermesHome,
                    DATABASE_PATH: path.join(dir, 'app.sqlite'),
                    PYTHONPATH: runtime
                }
            })
            assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
            const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
            assert.equal(out.growth, 0, JSON.stringify(out))
            assert.deepEqual(out.leftover, [])
            for (const cycle of out.cycle_growth) {
                assert.deepEqual(cycle.left, [])
                assert.equal(cycle.all, 0)
            }
            assert.equal(out.sibling.server_connected, true)
            assert.equal(out.sibling.stderr_open, true)
            assert.equal(out.sibling.agent_open, true)
            assert.equal(out.sibling.gateway_open, true)
            assert.equal(out.sibling.log_grew, true)
            assert.deepEqual(out.reconcile.victim_left, [])
            assert.equal(out.reconcile.victim_server_gone, true)
            assert.equal(out.reconcile.sibling_server_connected, true)
            assert.equal(out.reconcile.sibling_log_grew, true)
            assert.equal(out.reconcile.sibling_stderr_open, true)
            assert.equal(out.safety.calls_release, true)
            assert.equal(out.safety.scoped_shutdown, true)
            assert.equal(out.safety.no_bare_shutdown, true)
            assert.equal(out.safety.no_scope_none, true)
            assert.equal(out.safety.calls_reregister_adopters, true)
            assert.equal(out.share.owner_server_gone, true)
            assert.equal(out.share.adopter_reconnected, true)
            assert.equal(out.share.orphans_cleared, true)
            assert.equal(out.share.independent_sibling_still, true)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
)
