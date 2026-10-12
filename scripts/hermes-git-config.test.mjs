// The vendored agent runtime must not run commands a repository defines in its own git config.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The runtime's bounded git probe imports psutil. Prefer the Hermes environment from
// scripts/setup-hermes.sh, then any interpreter that already has that dependency.
function interpreter() {
    const candidates = []
    if (process.env.HERMES_PYTHON) candidates.push(process.env.HERMES_PYTHON)
    const venv = path.join(ROOT, 'hermes', '.venv', 'bin', 'python')
    if (fs.existsSync(venv)) candidates.push(venv)
    candidates.push('python3')
    for (const python of candidates) {
        const probe = spawnSync(python, ['-c', 'import psutil'], { encoding: 'utf8' })
        if (probe.status === 0) return python
    }
    return null
}

const python = interpreter()

test(
    'workspace snapshot and worktree create/cleanup ignore repository git commands',
    { skip: python ? false : 'the agent runtime git probe imports psutil; run bash scripts/setup-hermes.sh or set HERMES_PYTHON' },
    () => {
        const result = spawnSync(python, [path.join(ROOT, 'scripts', 'hermes-git-config.py')], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { ...process.env, PYTHONPATH: path.join(ROOT, 'hermes') }
        })
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
        assert.match(result.stdout, /hardened snapshot, create, and cleanup did not/)
    }
)
