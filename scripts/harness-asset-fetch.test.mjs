// The assets specialist's download helper (packages/harness/presets/assets/cuttlely_fetch.py): address checks on
// every hop, size and time caps, and the browser-like user agent. Its tests use only the Python standard library.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = path.join(ROOT, 'packages', 'harness', 'presets', 'assets', 'test_cuttlely_fetch.py')

test('the assets fetch helper passes its Python tests', () => {
    const python = process.env.HERMES_PYTHON || 'python3'
    const result = spawnSync(python, [TESTS], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /Ran \d+ tests[\s\S]*\nOK\s*$/)
})
