// A failed tool call's preview on the run stream keeps its tail (the exception, the URL, the HTTP status) instead of
// being cut after the first 500 characters. Runs _tool_completed_preview from the vendored runtime with the standard
// library and the runtime's own redactor (agent/redact.py), so it needs no runtime virtualenv.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'hermes', 'gateway', 'platforms', 'api_server_runs.py')

const PROBE = String.raw`
import ast, json, os, sys
from typing import Any, Callable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[1])))))
from agent.redact import redact_sensitive_text
source = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(source)
keep = []
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name == "_tool_completed_preview":
        keep.append(node)
    elif isinstance(node, ast.Assign) and any(getattr(t, "id", "").startswith("_TOOL_COMPLETED_") for t in node.targets):
        keep.append(node)
scope = {"json": json, "Any": Any, "Callable": Callable}
exec(compile(ast.Module(body=keep, type_ignores=[]), "api_server_runs", "exec"), scope)
preview = scope["_tool_completed_preview"]
redact = redact_sensitive_text
url = "https://commons.wikimedia.org/wiki/Special:FilePath/Example_logo.svg"
signed = "https://cdn.example.com/logo.png?token=opaque-signed-value-123&w=64"
error = json.dumps({"status": "error", "output": "x" * 900 + " fetched " + signed + " " + "y" * 900,
                    "error": "Traceback ...\nurllib.error.HTTPError: HTTP Error 403: Forbidden for " + url})
tail_only = json.dumps({"status": "error", "output": "w" * 1500,
                        "error": "HTTP Error 403 for https://u:pw-value-9@cdn.example.com/a.svg?sig=opaque-sig-456"})
ok = json.dumps({"status": "success", "output": "z" * 900 + " end"})
print(json.dumps({"error": preview(error, redact, True), "ok": preview(ok, redact, False),
                  "default": preview(ok, redact), "short": preview('{"status": "error", "error": "boom"}', redact, True),
                  "tail": preview(tail_only, redact, True)}))
`

test('a failed tool preview keeps its head and its tail; a successful one is cut as before', () => {
    const result = spawnSync(process.env.HERMES_PYTHON || 'python3', ['-c', PROBE, SOURCE], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const out = JSON.parse(result.stdout)
    assert.ok(out.error.startsWith('{"status": "error"'), out.error)
    assert.ok(
        out.error.endsWith('HTTP Error 403: Forbidden for https://commons.wikimedia.org/wiki/Special:FilePath/Example_logo.svg"}'),
        out.error
    )
    assert.ok(out.error.includes(' ... '))
    assert.ok(out.error.length <= 1200, String(out.error.length))
    assert.ok(!out.error.includes('opaque-signed-value-123'), out.error)
    // URL credentials in the kept tail go through the runtime's own redactor before anything is cut.
    assert.ok(out.tail.endsWith('"}'), out.tail)
    assert.ok(!out.tail.includes('opaque-sig-456') && !out.tail.includes('pw-value-9'), out.tail)
    assert.ok(out.tail.includes('HTTP Error 403 for'), out.tail)
    assert.equal(out.ok.length, 500)
    assert.ok(out.ok.endsWith('...'))
    assert.equal(out.default, out.ok)
    assert.equal(out.short, '{"status": "error", "error": "boom"}')
})

const FAILURE_PROBE = String.raw`
import ast, json, sys
from typing import Any
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name == "_result_reports_failure")
        or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "_FAILED_RESULT_STATUSES" for t in n.targets))]
scope = {"json": json, "Any": Any}
exec(compile(ast.Module(body=keep, type_ignores=[]), "api_server_runs", "exec"), scope)
f = scope["_result_reports_failure"]
cases = [json.dumps({"status": "interrupted", "output": "x" * 2000, "exit_code": 130}),
         json.dumps({"status": "timeout"}), json.dumps({"output": "", "exit_code": 2}), {"status": "error"},
         json.dumps({"status": "success", "output": "status: error", "exit_code": 0}), "plain text", None,
         json.dumps({"exit_code": True}), json.dumps({"nested": {"status": "error"}})]
print(json.dumps([f(c) for c in cases]))
`

test('a result that reports its own failure keeps its tail even without the runtime error flag', () => {
    const result = spawnSync(process.env.HERMES_PYTHON || 'python3', ['-c', FAILURE_PROBE, SOURCE], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(JSON.parse(result.stdout), [true, true, true, true, false, false, false, false, false])
    const text = fs.readFileSync(SOURCE, 'utf8')
    assert.match(text, /failed = bool\(kwargs\.get\("is_error"\)\) or _result_reports_failure\(kwargs\.get\("result"\)\)/)
    assert.match(text, /event_fields\["error"\] = failed/)
    assert.match(text, /_tool_completed_preview\(\s*kwargs\.get\("result"\), redact_sensitive_text, failed\)/)
})
