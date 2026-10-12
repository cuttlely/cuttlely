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

// A present hermes/.venv that cannot import is a broken setup, not a reason to skip.
// Skip only when that directory is absent and every other interpreter fails too.
export function chooseRuntime(results, { venvPresent }) {
    for (const result of results) {
        if (!result.failure) return { action: 'run', label: result.label, command: result.command, detail: '' }
    }
    if (venvPresent) {
        const venv = results.find((result) => result.label === 'hermes/.venv')
        return {
            action: 'fail',
            label: 'hermes/.venv',
            command: venv?.command || '',
            detail: venv?.failure || 'hermes/.venv could not be probed'
        }
    }
    const tried = results.map((result) => `${result.label}: ${result.failure}`).join(' ')
    return {
        action: 'skip',
        label: '',
        command: '',
        detail: `no runtime Python can import what scripts/hermes-git-config.py loads, including ruamel and psutil. ${tried} Run bash scripts/setup-hermes.sh.`
    }
}

function interpreter(modules) {
    const venvPresent = fs.existsSync(VENV_PYTHON)
    return chooseRuntime(
        candidates().map((candidate) => ({ ...candidate, failure: probe(candidate.command, modules) })),
        { venvPresent }
    )
}

const chosen = interpreter(proofModules(fs.readFileSync(PROOF, 'utf8')))

test('chooseRuntime fails a broken hermes/.venv when nothing else can import', () => {
    const broken = 'ruamel.yaml: ModuleNotFoundError: No module named ruamel'
    const decision = chooseRuntime(
        [
            { label: 'hermes/.venv', command: '/venv/python', failure: broken },
            { label: 'python3', command: 'python3', failure: 'psutil: ModuleNotFoundError: No module named psutil' }
        ],
        { venvPresent: true }
    )
    assert.equal(decision.action, 'fail')
    assert.equal(decision.detail, broken)
})

test('chooseRuntime skips only when hermes/.venv is absent and nothing else can import', () => {
    const decision = chooseRuntime(
        [{ label: 'python3', command: 'python3', failure: 'psutil: ModuleNotFoundError: No module named psutil' }],
        {
            venvPresent: false
        }
    )
    assert.equal(decision.action, 'skip')
    assert.match(decision.detail, /No module named psutil/)
    const fallback = chooseRuntime(
        [
            { label: 'hermes/.venv', command: '/venv/python', failure: 'ruamel.yaml: ModuleNotFoundError: No module named ruamel' },
            { label: 'python3', command: 'python3', failure: '' }
        ],
        { venvPresent: true }
    )
    assert.equal(fallback.action, 'run')
    assert.equal(fallback.label, 'python3')
    assert.equal(
        chooseRuntime(
            [
                { label: 'hermes/.venv', command: '/venv/python', failure: '' },
                { label: 'python3', command: 'python3', failure: 'unused' }
            ],
            { venvPresent: true }
        ).label,
        'hermes/.venv'
    )
})

test(
    'workspace snapshot and worktree create/cleanup ignore repository git commands',
    { skip: chosen.action === 'skip' ? chosen.detail : false },
    () => {
        if (chosen.action === 'fail') assert.fail(`hermes/.venv exists but cannot import the git-config proof. ${chosen.detail}`)
        console.log(`git-config proof uses ${chosen.label}`)
        const result = spawnSync(chosen.command, [PROOF], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { ...process.env, PYTHONPATH: HERMES, PYTHONDONTWRITEBYTECODE: '1' }
        })
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
        assert.match(result.stdout, /hardened snapshot, create, and cleanup did not/)
    }
)
