// Maximum concurrent agent runs (CUTTLELY_HERMES_MAX_CONCURRENT_RUNS) reaches the agent runtime through
// gateway.api_server.max_concurrent_runs in $HERMES_HOME/config.yaml, written by scripts/cuttlely-hermes-api.py
// before the runtime starts. Runs the launcher's own functions with the standard library (JSON is valid YAML),
// so it needs no runtime virtualenv.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCHER = path.join(ROOT, 'scripts', 'cuttlely-hermes-api.py')

// Loads only the constants and functions the merge needs, then runs one step and prints the result.
const PROBE = String.raw`
import ast, json, os, sys
source = open(sys.argv[1], encoding="utf-8").read()
keep = []
for node in ast.parse(source).body:
    if isinstance(node, ast.FunctionDef) and node.name in ("parse_max_concurrent_runs", "write_text_atomic", "apply_max_concurrent_runs"):
        keep.append(node)
    elif isinstance(node, ast.Assign) and any(getattr(t, "id", "").startswith("MAX_CONCURRENT_RUNS_") for t in node.targets):
        keep.append(node)
scope = {"os": os, "sys": sys}
exec(compile(ast.Module(body=keep, type_ignores=[]), "launcher", "exec"), scope)
from pathlib import Path
config = Path(sys.argv[2])
raw = sys.argv[3] if len(sys.argv) > 3 else None
result = scope["apply_max_concurrent_runs"](config, raw, json.loads, lambda data: json.dumps(data, indent=2))
print(json.dumps({"result": result, "parse": [scope["parse_max_concurrent_runs"](v) for v in ["0", "10", "50", "51", "100", "-1", "1.5", " 7 ", "", None, "ten"]]}))
`

function python() {
    return process.env.HERMES_PYTHON || 'python3'
}

function run(config, raw) {
    const args = ['-c', PROBE, LAUNCHER, config]
    if (raw !== undefined) args.push(raw)
    const result = spawnSync(python(), args, { encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return { ...JSON.parse(result.stdout), stderr: result.stderr }
}

function home(initial) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-max-runs-'))
    const config = path.join(dir, 'config.yaml')
    fs.writeFileSync(config, JSON.stringify(initial))
    fs.chmodSync(config, 0o600)
    return { dir, config, read: () => JSON.parse(fs.readFileSync(config, 'utf8')), files: () => fs.readdirSync(dir).sort() }
}

const BASE = { gateway: { multiplex_profiles: true }, agent: { disabled_toolsets: ['terminal'] } }

test('the value accepted is a whole number from 0 to 50; 51 is refused', () => {
    const h = home(BASE)
    try {
        assert.deepEqual(run(h.config).parse, [0, 10, 50, null, null, null, null, 7, null, null, null])
    } finally {
        fs.rmSync(h.dir, { recursive: true, force: true })
    }
})

test('unset leaves config.yaml alone, so the runtime default of 10 applies', () => {
    const h = home(BASE)
    try {
        const before = fs.readFileSync(h.config, 'utf8')
        assert.equal(run(h.config).result, null)
        assert.equal(fs.readFileSync(h.config, 'utf8'), before)
        assert.deepEqual(h.files(), ['config.yaml'])
    } finally {
        fs.rmSync(h.dir, { recursive: true, force: true })
    }
})

test('a saved value is merged under gateway.api_server without touching other keys', () => {
    const h = home({ ...BASE, gateway: { ...BASE.gateway, api_server: { cors_origins: 'x' } } })
    try {
        assert.equal(run(h.config, '25').result, 25)
        assert.deepEqual(h.read(), {
            gateway: { multiplex_profiles: true, api_server: { cors_origins: 'x', max_concurrent_runs: 25 } },
            agent: { disabled_toolsets: ['terminal'] }
        })
        assert.equal(fs.statSync(h.config).mode & 0o777, 0o600)
        assert.deepEqual(h.files(), ['.cuttlely-max-concurrent-runs', 'config.yaml'])
        assert.equal(run(h.config, '0').result, 0)
        assert.equal(h.read().gateway.api_server.max_concurrent_runs, 0)
    } finally {
        fs.rmSync(h.dir, { recursive: true, force: true })
    }
})

test('a saved value replaces a hand-written one; clearing the setting removes only what Cuttlely wrote', () => {
    const h = home({ ...BASE, gateway: { ...BASE.gateway, api_server: { max_concurrent_runs: 3 } } })
    try {
        assert.equal(run(h.config, '40').result, 40)
        assert.equal(h.read().gateway.api_server.max_concurrent_runs, 40)
        assert.equal(run(h.config, '').result, null)
        assert.deepEqual(h.read(), BASE)
        assert.deepEqual(h.files(), ['config.yaml'])
    } finally {
        fs.rmSync(h.dir, { recursive: true, force: true })
    }
})

test('clearing the setting keeps a value an operator typed after Cuttlely wrote one', () => {
    const h = home(BASE)
    try {
        run(h.config, '40')
        const edited = h.read()
        edited.gateway.api_server.max_concurrent_runs = 7
        fs.writeFileSync(h.config, JSON.stringify(edited))
        assert.equal(run(h.config).result, null)
        assert.equal(h.read().gateway.api_server.max_concurrent_runs, 7)
        assert.deepEqual(h.files(), ['config.yaml'])
    } finally {
        fs.rmSync(h.dir, { recursive: true, force: true })
    }
})

test('an unusable value leaves config.yaml as it is and says so without echoing the value', () => {
    const h = home({ ...BASE, gateway: { ...BASE.gateway, api_server: { max_concurrent_runs: 5 } } })
    try {
        const before = fs.readFileSync(h.config, 'utf8')
        for (const raw of ['51', '-1', 'lots']) {
            const out = run(h.config, raw)
            assert.equal(out.result, null)
            assert.match(out.stderr, /must be a whole number from 0 to 50/)
            assert.ok(!out.stderr.includes(raw))
        }
        assert.equal(fs.readFileSync(h.config, 'utf8'), before)
    } finally {
        fs.rmSync(h.dir, { recursive: true, force: true })
    }
})

test('the launcher applies the value before the runtime starts', () => {
    const launcher = fs.readFileSync(LAUNCHER, 'utf8')
    const applied = launcher.indexOf('apply_saved_max_concurrent_runs(config)')
    assert.ok(applied > 0 && applied < launcher.indexOf('import cli'), 'apply runs before the runtime is imported')
})
