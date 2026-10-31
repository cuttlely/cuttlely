// A harness bridge is named after its specialist, so a data specialist's query tool is mcp__data__query.
// Hermes must add the chat scope for that bridge too, or the gateway files the call under no chat and the run
// trace loses the query step's rows and timings. Loads tools/mcp_tool_cuttlely.py with the standard library only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'hermes', 'tools', 'mcp_tool_cuttlely.py')
const PROFILE = path.join(ROOT, 'packages', 'harness', 'profile.mjs')

const PROBE = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tool_cuttlely", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
call = mod.analyst_call_arguments
bridge = {"command": "node", "env": {"CUTTLELY_ANALYST_BRIDGE": "1"}}
args = {"sql": "select 1"}
print(json.dumps({
    "data": call("data", args, "sales--data:chat-9", bridge),
    "analyst": call("analyst", args, "sales--analyst:chat-9"),
    "plain": call("data", args, "sales--data:chat-9", {"command": "node", "env": {}}),
    "other": call("github", args, "sales--data:chat-9", {"command": "npx"}),
    "noSession": call("data", args, "", bridge),
    "argsUntouched": args,
}))
`

test('Hermes adds the chat scope for a query bridge whatever the specialist is called', () => {
    const run = spawnSync('python3', ['-c', PROBE, SOURCE], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const out = JSON.parse(run.stdout)
    assert.deepEqual(out.data, { sql: 'select 1', _cuttlelyScope: 'sales--data:chat-9' })
    assert.deepEqual(out.analyst, { sql: 'select 1', _cuttlelyScope: 'sales--analyst:chat-9' })
    assert.deepEqual(out.plain, { sql: 'select 1' })
    assert.deepEqual(out.other, { sql: 'select 1' })
    assert.deepEqual(out.noSession, { sql: 'select 1' })
    assert.deepEqual(out.argsUntouched, { sql: 'select 1' })
})

// The real tool handler, a real server task bound through _prepare_run with a config that went through the
// runtime's own mcp_servers filter and env interpolation, and the real argument helper. Only the connection
// lookup and the wire call are replaced, so the test sees the arguments the bridge would receive.
// It needs the runtime's packages: HERMES_PYTHON, then hermes/.venv, then python3. Without them it skips,
// unless CUTTLELY_REQUIRE_HERMES_RUNTIME=1 (the image build in CI sets it).
const HANDLER_PROBE = String.raw`
import asyncio, json, sys, types
sys.path.insert(0, sys.argv[1])
from tools import mcp_tool_handlers as handlers
from tools.mcp_tool import MCPServerTask
from tools.mcp_tool_config import _filter_suspicious_mcp_servers, _interpolate_env_vars
from tools.mcp_tool_loop import _ensure_mcp_loop, _stop_mcp_loop
sent = {}
def run(server_name, config, session_id):
    servers = _filter_suspicious_mcp_servers({server_name: config})
    server = MCPServerTask(server_name)
    asyncio.run(server._prepare_run(_interpolate_env_vars(servers[server_name])))
    async def wire(srv, name, tool, args):
        sent[name] = dict(args)
        return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text='{"rows":[]}')], isError=False)
    handlers._acquire_call_server = lambda name, timeout: (server, None)
    handlers._cuttlely_refresh_toolless = lambda srv, name: None
    handlers._call_tool_racing_stdio_death = wire
    handlers._make_tool_handler(server_name, "query", 10)({"sql": "select 1"}, session_id=session_id)
    return sent.get(server_name)
bridge = {"command": "node", "args": ["packages/harness/mcp-bridge.mjs", "--harness", "sales", "--specialist", "data"],
          "env": {"CUTTLELY_ANALYST_BRIDGE": "1"}}
plain = {"command": "npx", "args": ["some-mcp-server"], "env": {}}
_ensure_mcp_loop()
try:
    out = {"data": run("data", bridge, "sales--data:chat-9"), "plain": run("github", plain, "sales--data:chat-9")}
finally:
    _stop_mcp_loop()
print(json.dumps(out))
`

function runtimePython() {
    const venv = path.join(ROOT, 'hermes', '.venv', 'bin', 'python')
    const list = [process.env.HERMES_PYTHON, fs.existsSync(venv) ? venv : '', 'python3'].filter(Boolean)
    for (const command of list) {
        const probe = spawnSync(
            command,
            ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import tools.mcp_tool', path.join(ROOT, 'hermes')],
            {
                encoding: 'utf8'
            }
        )
        if (probe.status === 0) return command
    }
    return ''
}

const PYTHON = runtimePython()
const REQUIRED = process.env.CUTTLELY_REQUIRE_HERMES_RUNTIME === '1'
const SKIP = !PYTHON && !REQUIRED ? 'no Python here can import the runtime (tools.mcp_tool); run bash scripts/setup-hermes.sh' : false

test('the real MCP tool handler sends the chat scope to a query bridge named after its specialist', { skip: SKIP }, () => {
    assert.ok(PYTHON, 'CUTTLELY_REQUIRE_HERMES_RUNTIME=1 but no Python here can import tools.mcp_tool')
    const run = spawnSync(PYTHON, ['-c', HANDLER_PROBE, path.join(ROOT, 'hermes')], {
        encoding: 'utf8',
        env: { ...process.env, HERMES_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-')) }
    })
    assert.equal(run.status, 0, run.stderr)
    const out = JSON.parse(run.stdout.trim().split('\n').at(-1))
    assert.deepEqual(out.data, { sql: 'select 1', _cuttlelyScope: 'sales--data:chat-9' })
    assert.deepEqual(out.plain, { sql: 'select 1' })
})

test('the compiler emits the runtime scope flag for an actual query bridge', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-scope-profile-'))
    try {
        const source = `
            import assert from 'node:assert/strict'
            import fs from 'node:fs'
            import path from 'node:path'
            import { compileProfile } from ${JSON.stringify(pathToFileURL(PROFILE).href)}
            const record = { name: 'query-scope', chief: { model: { nodeName: 'unused' } }, specialists: [
                { name: 'data', mcpServers: [{ nodeName: 'postgreSQLMCP', category: 'Tools (MCP)', inputs: {} }] }
            ] }
            compileProfile(record)
            const config = fs.readFileSync(path.join(process.env.CUTTLELY_HERMES_HOME, 'profiles', 'query-scope--data', 'config.yaml'), 'utf8')
            assert.ok(/CUTTLELY_ANALYST_BRIDGE:\\s*['"]?1/.test(config))
        `
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
            encoding: 'utf8',
            timeout: 10000,
            env: { ...process.env, CUTTLELY_DATA_DIR: dir, CUTTLELY_HERMES_HOME: path.join(dir, 'runtime') }
        })
        assert.equal(run.status, 0, run.stderr)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
