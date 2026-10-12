// The vendored agent runtime must not run commands a repository defines in its own git config.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROOF = path.join(ROOT, 'scripts', 'hermes-git-config.py')
const HERMES = path.join(ROOT, 'hermes')
const VENV_PYTHON = path.join(HERMES, '.venv', 'bin', 'python')

// stdlib imports do not tell two interpreters apart. ruamel and psutil are not named
// in the proof file; worktree cleanup imports ruamel, and the bounded git probe imports psutil.
const STDLIB = /^(?:import|from)\s+(?:__future__|os|subprocess|sys|tempfile|time|pathlib)\b/

function proofModules(source) {
    // psutil and ruamel are loaded by the helpers the proof calls, not by its own import lines.
    const names = ['psutil', 'ruamel.yaml']
    for (const raw of source.split('\n')) {
        const text = raw.trim().replace(/\s+#.*$/, '')
        if (!text || STDLIB.test(text)) continue
        const imported = /^import\s+([A-Za-z0-9_.]+)/.exec(text)
        if (imported) {
            names.push(imported[1])
            continue
        }
        const from = /^from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/.exec(text)
        if (!from) continue
        const base = from[1]
        const parts = from[2]
            .split(',')
            .map((part) => part.trim().replace(/\s+as\s+\S+$/, ''))
            .filter(Boolean)
        // `from package.module import symbol` loads the module. `from package import name` loads a submodule.
        if (base.includes('.')) names.push(base)
        else for (const part of parts) names.push(`${base}.${part}`)
    }
    return [...new Set(names)]
}

function candidates() {
    const list = []
    if (fs.existsSync(VENV_PYTHON)) list.push({ label: 'hermes/.venv', command: VENV_PYTHON })
    const fromEnv = process.env.HERMES_PYTHON
    if (fromEnv && path.resolve(fromEnv) !== path.resolve(VENV_PYTHON)) list.push({ label: 'HERMES_PYTHON', command: fromEnv })
    list.push({ label: 'python3', command: 'python3' })
    return list
}

const PROBE = `
import importlib, sys
sys.path.insert(0, sys.argv[1])
for name in sys.argv[2:]:
    try:
        importlib.import_module(name)
    except Exception as error:
        sys.stderr.write(f"{name}: {type(error).__name__}: {error}\\n")
        raise SystemExit(1)
`

function probe(command, modules) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-git-config-probe-'))
    const result = spawnSync(command, ['-c', PROBE, HERMES, ...modules], {
        encoding: 'utf8',
        cwd: ROOT,
        env: {
            ...process.env,
            PYTHONPATH: HERMES,
            PYTHONDONTWRITEBYTECODE: '1',
            HERMES_HOME: home,
            HOME: home
        }
    })
    fs.rmSync(home, { recursive: true, force: true })
    if (result.error) return result.error.message
    if (result.status === 0) return ''
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim()
    return detail.split('\n').find((line) => line.trim()) || `exit ${result.status}`
}

function interpreter(modules) {
    const tried = []
    for (const candidate of candidates()) {
        const failure = probe(candidate.command, modules)
        if (!failure) return { python: candidate.command, label: candidate.label, tried }
        tried.push(`${candidate.label}: ${failure}`)
    }
    return { python: null, label: '', tried }
}

const chosen = interpreter(proofModules(fs.readFileSync(PROOF, 'utf8')))
const skipReason = chosen.python
    ? false
    : `no runtime Python can import what scripts/hermes-git-config.py loads, including ruamel and psutil. ${chosen.tried.join(
          ' '
      )} Run bash scripts/setup-hermes.sh.`

test('workspace snapshot and worktree create/cleanup ignore repository git commands', { skip: skipReason }, () => {
    if (fs.existsSync(VENV_PYTHON)) assert.equal(path.resolve(chosen.python), path.resolve(VENV_PYTHON))
    console.log(`git-config proof uses ${chosen.label}`)
    const result = spawnSync(chosen.python, [PROOF], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: HERMES, PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /hardened snapshot, create, and cleanup did not/)
})
