import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.HERMES_PYTHON || path.join(root, 'hermes/.venv/bin/python')

test('changed MCP schema refreshes in its existing profile; A-B-A scopes stay isolated', { timeout: 90000 }, (t) => {
    if (!fs.existsSync(python)) {
        if (process.env.CUTTLELY_REQUIRE_HERMES_RUNTIME === '1') assert.fail('Hermes runtime required')
        t.skip('Set HERMES_PYTHON or install hermes/.venv for real runtime integration')
        return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-schema-refresh-'))
    try {
        const run = spawnSync(python, [path.join(root, 'scripts/fixtures/mcp-schema-refresh-probe.py'), root, dir], {
            encoding: 'utf8',
            timeout: 85000,
            env: { ...process.env, HERMES_HOME: dir, PYTHONPATH: path.join(root, 'hermes'), NO_PROXY: '*', PYTHONUNBUFFERED: '1' }
        })
        assert.equal(run.status, 0, run.stderr + run.stdout)
        const result = JSON.parse(run.stdout.trim().split('\n').at(-1))
        assert.equal(result.ok, true)
        assert.equal(result.a_connections, 4)
        assert.equal(result.b_connections, 1)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
