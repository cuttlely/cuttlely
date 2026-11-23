// Exercise only the startup export block and launcher helper, without starting either service.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

const script = fs.readFileSync(new URL('./start-cuttlely.sh', import.meta.url), 'utf8')
const block = script.slice(script.indexOf('export_hermes_terminal_limits()'), script.indexOf('# A local install gets'))
const launcher = new URL('./cuttlely-hermes-api.py', import.meta.url)
const probe = String.raw`
import ast, json, sys
nodes = ast.parse(open(sys.argv[1], encoding="utf-8").read()).body
scope = {}
exec(compile(ast.Module(body=[n for n in nodes if isinstance(n, ast.FunctionDef) and n.name == "apply_terminal_limits"], type_ignores=[]), "launcher", "exec"), scope)
env = json.loads(sys.argv[2])
scope["apply_terminal_limits"](env)
print(json.dumps({k: v for k, v in env.items() if k.startswith("TERMINAL_")}))
`

function bash(env) {
    return execFileSync(
        'bash',
        ['-c', `set -euo pipefail\n${block}\nprintf '%s|%s' "\${TERMINAL_TIMEOUT-unset}" "\${TERMINAL_MAX_FOREGROUND_TIMEOUT-unset}"`],
        {
            env: { PATH: process.env.PATH, ...env },
            encoding: 'utf8'
        }
    )
}

function python(env) {
    return JSON.parse(
        execFileSync(process.env.HERMES_PYTHON || 'python3', ['-c', probe, launcher.pathname, JSON.stringify(env)], { encoding: 'utf8' })
    )
}

test('unset caps leave the runtime environment untouched in the shell and Python launcher', () => {
    assert.ok(block.startsWith('export_hermes_terminal_limits()'))
    assert.equal(bash({}), 'unset|unset')
    assert.deepEqual(python({}), {})
    const env = { TERMINAL_TIMEOUT: '240', TERMINAL_MAX_FOREGROUND_TIMEOUT: '700' }
    assert.equal(bash(env), '240|700')
    assert.deepEqual(python(env), env)
})

test('configured caps reach the runtime before import and override native host names', () => {
    const env = { CUTTLELY_HERMES_TERMINAL_TIMEOUT: '1800', CUTTLELY_HERMES_TERMINAL_MAX_FOREGROUND: '3600', TERMINAL_TIMEOUT: '240' }
    assert.equal(bash(env), '1800|3600')
    assert.deepEqual(python(env), { TERMINAL_TIMEOUT: '1800', TERMINAL_MAX_FOREGROUND_TIMEOUT: '3600' })
    for (const value of ['', 'bad', '0', '3601', '1.5']) {
        assert.equal(bash({ CUTTLELY_HERMES_TERMINAL_TIMEOUT: value }), 'unset|unset')
        assert.deepEqual(python({ CUTTLELY_HERMES_TERMINAL_TIMEOUT: value }), {})
    }
    const source = fs.readFileSync(launcher, 'utf8')
    assert.ok(source.indexOf('apply_terminal_limits(os.environ)') < source.indexOf('import cli'))
})

test('the multiplexed runtime takes terminal timeout from the profile policy', () => {
    const program = String.raw`
import importlib.util, json, os, pathlib, sys, tempfile, types
sys.dont_write_bytecode = True
root = pathlib.Path(sys.argv[1])
config = types.ModuleType("hermes_cli.config")
config.TERMINAL_CONFIG_ENV_MAP = {"timeout": "TERMINAL_TIMEOUT", "cwd": "TERMINAL_CWD"}
config._terminal_env_value = str
sys.modules["hermes_cli.config"] = config
defaults = types.ModuleType("hermes_cli.config_defaults")
defaults.DEFAULT_CONFIG = {"terminal": {"timeout": 180}}
sys.modules["hermes_cli.config_defaults"] = defaults
utils = types.ModuleType("utils")
utils.load_yaml_file_readonly = lambda path: json.loads(path.read_text())
sys.modules["utils"] = utils
spec = importlib.util.spec_from_file_location("terminal_scope", root / "hermes/tools/terminal_scope.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
os.environ["TERMINAL_TIMEOUT"] = "1800"
with tempfile.TemporaryDirectory() as folder:
    home = pathlib.Path(folder)
    path = home / "config.yaml"
    path.write_text(json.dumps({"terminal": {"cwd": folder}}))
    assert module.build_profile_terminal_scope(home)["TERMINAL_TIMEOUT"] == "180"
    path.write_text(json.dumps({"terminal": {"cwd": folder, "timeout": 1800}}))
    assert module.build_profile_terminal_scope(home)["TERMINAL_TIMEOUT"] == "1800"
print("ok")
`
    assert.equal(
        execFileSync(process.env.HERMES_PYTHON || 'python3', ['-c', program, new URL('..', import.meta.url).pathname], {
            encoding: 'utf8'
        }).trim(),
        'ok'
    )
})
