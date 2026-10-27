// A harness bridge is named after its specialist, so a data specialist's query tool is mcp__data__query.
// Hermes must add the chat scope for that bridge too, or the gateway files the call under no chat and the run
// trace loses the query step's rows and timings. Loads tools/mcp_tool_cuttlely.py with the standard library only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

test('the harness profile still marks a query bridge with the env flag Hermes reads', () => {
    const source = fs.readFileSync(PROFILE, 'utf8')
    assert.match(source, /hasAnalystTool\(specialist\) \? \{ CUTTLELY_ANALYST_BRIDGE: '1'/)
})
