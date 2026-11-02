import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(ROOT, 'hermes')
const python = [process.env.HERMES_PYTHON, path.join(runtime, '.venv/bin/python'), 'python3']
    .filter(Boolean)
    .find(
        (command) =>
            spawnSync(command, [
                '-c',
                'import sys; sys.path.insert(0, sys.argv[1]); from tools.budget_config import budget_for_context_window; from hermes_cli.config import load_config_readonly',
                runtime
            ]).status === 0
    )
const PROBE = String.raw`
import json, pathlib, sys
sys.path.insert(0, sys.argv[1])
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools.budget_config import budget_for_context_window
from tools.tool_result_storage import maybe_persist_tool_result
root = pathlib.Path(sys.argv[2])
for name, config in {
    'a': 'tool_budget:\n  mcp_result_size_chars: 316573\n  default_result_size_chars: 316573\n  turn_budget_chars: 633146\n',
    'b': '{}\n',
    'invalid': 'tool_budget:\n  mcp_result_size_chars: true\n  default_result_size_chars: 999999999\n  turn_budget_chars: 1.5\n',
}.items():
    home = root / name
    home.mkdir()
    (home / 'config.yaml').write_text(config)

def probe(name, context=1000000):
    token = set_hermes_home_override(root / name)
    try:
        config = budget_for_context_window(context)
        payload = json.dumps({'result': 'source evidence ' * 14000})
        inline = maybe_persist_tool_result(payload, 'mcp_fixture_query', 'fixture', config=config)
        oversized = maybe_persist_tool_result('x' * 400000, 'mcp_fixture_query', 'large', config=config)
        return [config.default_result_size, config.turn_budget, config.resolve_threshold('mcp_fixture_query'),
                inline == payload, '<persisted-output>' in oversized]
    finally:
        reset_hermes_home_override(token)

print(json.dumps({'a': probe('a'), 'b': probe('b'), 'again': probe('a'), 'small': probe('a', 16000),
                  'invalid': probe('invalid'), 'unknown': probe('a', None)}))
`

test(
    'real runtime profiles retain expanded MCP evidence, isolate defaults, and still cap small contexts and oversized results',
    {
        skip: !python && process.env.CUTTLELY_REQUIRE_HERMES_RUNTIME !== '1' ? 'runtime Python dependencies unavailable' : false
    },
    () => {
        assert(python, 'Runtime Python dependencies are required')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-evidence-'))
        try {
            const result = spawnSync(python, ['-c', PROBE, runtime, dir], { encoding: 'utf8', env: { ...process.env, HERMES_HOME: dir } })
            assert.equal(result.status, 0, result.stderr)
            const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
            assert.deepEqual(out.a, [316573, 633146, 316573, true, true])
            assert.deepEqual(out.again, out.a)
            assert.deepEqual(out.unknown, out.a)
            assert.deepEqual(out.b, [100000, 200000, 50000, false, true])
            assert.deepEqual(out.invalid, out.b)
            assert(out.small[0] < 50000)
            assert.equal(out.small[2], out.small[0])
            assert.equal(out.small[3], false)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
)
