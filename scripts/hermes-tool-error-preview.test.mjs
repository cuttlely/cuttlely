// A failed tool call's preview on the run stream keeps its tail (the exception, the URL, the HTTP status) instead of
// being cut after the first 500 characters. Runs _tool_completed_preview from the vendored runtime with the standard
// library only, so it needs no runtime virtualenv.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'hermes', 'gateway', 'platforms', 'api_server_runs.py')

const PROBE = String.raw`
import ast, json, sys
from typing import Any, Callable
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
redact = lambda text, force=False: text.replace("redact-me-word", "***")
url = "https://commons.wikimedia.org/wiki/Special:FilePath/Example_logo.svg"
error = json.dumps({"status": "error", "output": "x" * 900 + " note redact-me-word " + "y" * 900,
                    "error": "Traceback ...\nurllib.error.HTTPError: HTTP Error 403: Forbidden for " + url})
ok = json.dumps({"status": "success", "output": "z" * 900 + " end"})
print(json.dumps({"error": preview(error, redact, True), "ok": preview(ok, redact, False),
                  "default": preview(ok, redact), "short": preview('{"status": "error", "error": "boom"}', redact, True)}))
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
    assert.ok(!out.error.includes('redact-me-word'))
    assert.equal(out.ok.length, 500)
    assert.ok(out.ok.endsWith('...'))
    assert.equal(out.default, out.ok)
    assert.equal(out.short, '{"status": "error", "error": "boom"}')
})

test('the run stream passes the error flag to the preview', () => {
    const text = fs.readFileSync(SOURCE, 'utf8')
    assert.match(text, /_tool_completed_preview\(\s*kwargs\.get\("result"\), redact_sensitive_text, bool\(kwargs\.get\("is_error"\)\)\)/)
})
