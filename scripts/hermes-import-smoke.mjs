// Imports the Hermes modules Cuttlely runs from the vendored hermes/ tree, so a trim or an upgrade that drops a
// module Cuttlely needs fails pnpm verify. Uses HERMES_PYTHON, then hermes/.venv (scripts/setup-hermes.sh). With
// neither, it says so and skips: the vendor check still runs.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HERMES = path.join(ROOT, 'hermes')

// What scripts/cuttlely-hermes-api.py and a harness run load: the API server, the agent loop, delegation, MCP,
// skills and the CLI entry that builds profiles.
export const MODULES = [
    'run_agent',
    'model_tools',
    'toolsets',
    'tools.registry',
    'tools.delegate_tool',
    'tools.delegate_tool_toolsets',
    'tools.mcp_tool',
    'tools.mcp_tool_cuttlely',
    'tools.skills_tool',
    'gateway.run',
    'gateway.platforms.api_server',
    'hermes_cli.main',
    'tui_gateway.server'
]

export function hermesPython(env = process.env) {
    if (env.HERMES_PYTHON) return env.HERMES_PYTHON
    const venv = path.join(HERMES, '.venv', 'bin', 'python')
    return fs.existsSync(venv) ? venv : null
}

const PROBE = `
import importlib, json, os, sys
root = os.path.realpath(sys.argv[1])
report = sys.argv[2]
sys.path.insert(0, root)
os.chdir(root)
failed, outside = [], []
for name in sys.argv[3:]:
    try:
        module = importlib.import_module(name)
    except Exception as error:
        failed.append(f"{name}: {type(error).__name__}: {error}")
        continue
    where = os.path.realpath(getattr(module, "__file__", "") or "")
    if not where.startswith(root + os.sep):
        outside.append(f"{name} loaded from {where}")
# Some Hermes modules point stdout at stderr when they load, so the result goes to a file.
with open(report, "w") as out:
    json.dump({"failed": failed, "outside": outside}, out)
`

function main() {
    const python = hermesPython()
    if (!python) {
        console.log('hermes-import: skipped, no Hermes Python (set HERMES_PYTHON or run bash scripts/setup-hermes.sh).')
        return 0
    }
    const home = fs.mkdtempSync(path.join(ROOT, '.verify-hermes-home-'))
    try {
        const reportFile = path.join(home, 'import-report.json')
        const res = spawnSync(python, ['-c', PROBE, HERMES, reportFile, ...MODULES], {
            encoding: 'utf8',
            timeout: 180000,
            env: { ...process.env, HERMES_HOME: home, PYTHONDONTWRITEBYTECODE: '1' }
        })
        let report = null
        try {
            report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
        } catch {
            report = null
        }
        if (res.status !== 0 || !report) {
            console.error(`hermes-import: ${python} failed to run the import probe.\n${(res.stderr || res.stdout || '').trim()}`)
            return 1
        }
        const problems = [...report.failed, ...report.outside]
        if (problems.length) {
            for (const problem of problems) console.error(`hermes-import: ${problem}`)
            return 1
        }
        console.log(`hermes-import: ${MODULES.length} Hermes modules import from hermes/.`)
        return 0
    } finally {
        fs.rmSync(home, { recursive: true, force: true })
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
