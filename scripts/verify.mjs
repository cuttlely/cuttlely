// Local merge gate. Run this before a pull request.
// Full order fails fast. --fast is lint, typecheck, server unit tests, and the fast unit-test steps.
// The unit step caps Jest workers (default 50%). Override with CUTTLELY_VERIFY_JEST_WORKERS (a positive integer or a percentage).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPORT_DIR = path.join(ROOT, '.verify')
const require = createRequire(import.meta.url)

const STEPS = [
    {
        name: 'lint',
        fast: true,
        command: 'pnpm',
        args: ['lint']
    },
    {
        name: 'boundaries',
        fast: true,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'check-boundaries.mjs')]
    },
    {
        name: 'typecheck',
        fast: true,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'typecheck.mjs')]
    },
    {
        name: 'build',
        fast: false,
        // Chat widget, components, server, and UI. The API docs package is typechecked
        // in scripts/typecheck.mjs, which --fast also runs.
        command: 'pnpm',
        args: [
            'exec',
            'turbo',
            'run',
            'build',
            '--filter=@cuttlely/chat',
            '--filter=@cuttlely/components',
            '--filter=@cuttlely/server',
            '--filter=@cuttlely/ui'
        ],
        env: { NODE_OPTIONS: '--max-old-space-size=4096' }
    },
    {
        name: 'verify-test',
        fast: true,
        command: process.execPath,
        args: [
            '--test',
            path.join(ROOT, 'scripts', 'verify.test.mjs'),
            path.join(ROOT, 'scripts', 'architecture-map.test.mjs'),
            path.join(ROOT, 'scripts', 'check-boundaries.test.mjs'),
            path.join(ROOT, 'scripts', 'health-report.test.mjs'),
            path.join(ROOT, 'scripts', 'components-package-alias.test.mjs'),
            path.join(ROOT, 'scripts', 'package-names.test.mjs'),
            path.join(ROOT, 'scripts', 'proprietary-paths.test.mjs'),
            path.join(ROOT, 'scripts', 'etl-list-sqlite.test.mjs'),
            path.join(ROOT, 'scripts', 'start-local-admin.test.mjs'),
            path.join(ROOT, 'scripts', 'start-restart-loop.test.mjs'),
            path.join(ROOT, 'scripts', 'etl-delete-vectors.test.mjs'),
            path.join(ROOT, 'scripts', 'langflow-import.test.mjs'),
            path.join(ROOT, 'scripts', 'flowise-migration.test.mjs'),
            path.join(ROOT, 'scripts', 'api-key-hash.test.cjs'),
            path.join(ROOT, 'scripts', 'analyst-postgres.test.mjs'),
            path.join(ROOT, 'scripts', 'analyst-store.test.mjs'),
            path.join(ROOT, 'scripts', 'hermes-supervisor.test.mjs'),
            path.join(ROOT, 'scripts', 'hermes-start-wait.test.mjs'),
            path.join(ROOT, 'scripts', 'live-e2e-pick.test.mjs'),
            path.join(ROOT, 'scripts', 'template-gallery-wait.test.mjs'),
            path.join(ROOT, 'scripts', 'templates-respace.test.mjs'),
            path.join(ROOT, 'scripts', 'vendor-hermes.test.mjs'),
            path.join(ROOT, 'scripts', 'release.test.mjs'),
            path.join(ROOT, 'scripts', 'test-git-isolation.test.mjs'),
            path.join(ROOT, 'scripts', 'compose-image.test.mjs'),
            path.join(ROOT, 'scripts', 'omit-geoip-database.test.mjs'),
            path.join(ROOT, 'packages', 'cli', 'test', 'cli.test.js'),
            path.join(ROOT, 'scripts', 'upgrade-check.test.mjs'),
            path.join(ROOT, 'scripts', 'outbound-guard.test.mjs'),
            path.join(ROOT, 'scripts', 'model-list.test.mjs'),
            path.join(ROOT, 'scripts', 'brand-names.test.mjs'),
            path.join(ROOT, 'examples', 'web-app', 'server.test.mjs'),
            path.join(ROOT, 'website', 'scripts', 'sync-docs.test.mjs'),
            path.join(ROOT, 'website', 'scripts', 'check-site.test.mjs'),
            path.join(ROOT, 'website', 'scripts', 'screenshot-zoom.test.mjs')
        ]
    },
    {
        // Every link in docs/, the README quickstart, CHANGELOG, SECURITY and CREDITS resolves for the website.
        // Network-free and writes nothing; the full site build is `npm run build` in website/.
        name: 'website-docs',
        fast: true,
        command: process.execPath,
        args: [path.join(ROOT, 'website', 'scripts', 'sync-docs.mjs'), '--check-only']
    },
    {
        // The chat widget's own tests (markdown safety, stream parsing, share-setting mapping, DOM, contrast).
        name: 'chat-widget',
        fast: true,
        command: 'pnpm',
        args: ['--dir', 'packages/chat-widget', 'test']
    },
    {
        name: 'hermes-vendor',
        fast: true,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'vendor-hermes.mjs'), '--check']
    },
    {
        name: 'unit',
        fast: true,
        command: 'pnpm',
        args: ['--dir', 'packages/server', 'exec', 'jest', '--watchAll=false', '--forceExit'],
        env: { CI: 'true' }
    },
    {
        // Server settings page logic (packages/ui/src/views/serversettings/model.js).
        name: 'server-settings-ui',
        fast: true,
        command: 'pnpm',
        args: ['--dir', 'packages/ui', 'exec', 'jest', '--watchAll=false', 'src/views/serversettings', 'src/views/serversetup'],
        env: { CI: 'true' }
    },
    {
        name: 'hermes-import',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'hermes-import-smoke.mjs')]
    },
    {
        name: 'harness',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'harness', 'check.mjs')]
    },
    {
        name: 'proprietary-paths',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'proprietary-paths.mjs')]
    },
    {
        name: 'secrets',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'scan-secrets.mjs')]
    },
    {
        name: 'handoff-test',
        fast: true,
        command: process.execPath,
        args: ['--test', path.join(ROOT, 'scripts', 'handoff-paths.test.mjs')]
    },
    {
        name: 'render-blueprint',
        fast: true,
        command: process.execPath,
        args: ['--test', path.join(ROOT, 'scripts', 'render-blueprint.test.mjs')]
    },
    {
        name: 'identity-migration',
        fast: true,
        command: process.execPath,
        args: ['--test', path.join(ROOT, 'scripts', 'identity-migration.test.cjs')]
    },
    {
        name: 'identity-entity-smoke',
        fast: false,
        command: process.execPath,
        args: ['--test', path.join(ROOT, 'scripts', 'identity-entity-smoke.test.cjs')]
    },
    {
        name: 'workspace-scope-isolation',
        fast: false,
        command: process.execPath,
        args: ['--test', path.join(ROOT, 'scripts', 'workspace-scope.isolation.test.cjs')]
    },
    {
        name: 'handoff',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'handoff-paths.mjs')]
    },
    {
        name: 'smoke',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'smoke-server.mjs')]
    },
    {
        name: 'upgrade',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'upgrade-check.mjs')]
    },
    {
        // A start that cannot open the database after a settings change stops, and safe boot puts back what worked.
        name: 'safeboot',
        fast: false,
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'safeboot-check.mjs')]
    }
]

export function jestMaxWorkers() {
    const raw = process.env.CUTTLELY_VERIFY_JEST_WORKERS
    if (raw === undefined || raw.trim() === '') return '50%'
    const value = raw.trim()
    if (!/^[1-9]\d*%?$/.test(value)) {
        throw new Error(
            `CUTTLELY_VERIFY_JEST_WORKERS must be a positive integer or a percentage such as 50% (got ${JSON.stringify(value)})`
        )
    }
    return value
}

export function unitJestArgs() {
    return ['--dir', 'packages/server', 'exec', 'jest', '--watchAll=false', '--forceExit', `--maxWorkers=${jestMaxWorkers()}`]
}

function nodeProblem() {
    const major = Number(String(process.versions.node).split('.')[0])
    if (!Number.isFinite(major) || major < 24) {
        return `pnpm verify needs Node 24 or newer (node:sqlite). This process is Node ${process.version}. Install the version in .nvmrc and run again.`
    }
    try {
        require('node:sqlite')
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Node ${process.version} cannot load node:sqlite (${message}). Use Node 24.`
    }
    return ''
}

function parseArgs(argv) {
    let fast = false
    const skip = new Set()
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--fast') fast = true
        else if (arg === '--help' || arg === '-h') {
            console.log('pnpm verify [--fast] [--skip <step>]')
            console.log(`steps: ${STEPS.map((step) => step.name).join(', ')}`)
            console.log(
                '--fast runs lint, boundaries, typecheck, verify-test, website-docs, chat-widget, hermes-vendor, unit, server-settings-ui, handoff-test, render-blueprint, and identity-migration'
            )
            console.log('unit Jest workers default to 50%. Set CUTTLELY_VERIFY_JEST_WORKERS to a positive integer or a percentage.')
            process.exit(0)
        } else if (arg === '--skip') {
            const name = argv[i + 1]
            if (!name || name.startsWith('--')) throw new Error('--skip needs a step name')
            skip.add(name)
            i += 1
        } else if (arg.startsWith('--skip=')) skip.add(arg.slice('--skip='.length))
        else throw new Error(`Unknown argument ${arg}`)
    }
    const known = new Set(STEPS.map((step) => step.name))
    for (const name of skip) {
        if (!known.has(name)) throw new Error(`Unknown step "${name}". Steps: ${[...known].join(', ')}`)
    }
    return { fast, skip }
}

function gitHead() {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : ''
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

function writeReport(report) {
    fs.mkdirSync(REPORT_DIR, { recursive: true })
    fs.writeFileSync(path.join(REPORT_DIR, 'verify-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    const lines = [
        '## Cuttlely local verify',
        '',
        '| | |',
        '| --- | --- |',
        `| HEAD | \`${report.head || 'unknown'}\` |`,
        `| Node | \`${report.node}\` |`,
        `| Result | ${report.ok ? 'pass' : 'fail'} |`,
        `| Mode | ${report.mode} |`,
        '',
        '| Step | Result | Duration |',
        '| --- | --- | --- |'
    ]
    for (const step of report.steps) {
        lines.push(`| ${step.name} | ${step.status} | ${step.durationMs === null ? '' : formatDuration(step.durationMs)} |`)
    }
    if (report.error) {
        lines.push('', '```', report.error, '```')
    }
    lines.push('')
    fs.writeFileSync(path.join(REPORT_DIR, 'verify-summary.md'), lines.join('\n'))
}

function runStep(step) {
    const started = Date.now()
    console.log(`\n==> ${step.name}`)
    let args = step.args
    if (step.name === 'unit') {
        try {
            args = unitJestArgs()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(message)
            return { name: step.name, status: 'fail', durationMs: Date.now() - started }
        }
        console.log(`jest maxWorkers=${jestMaxWorkers()}`)
    }
    const result = spawnSync(step.command, args, {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...step.env }
    })
    const durationMs = Date.now() - started
    const status = result.status === 0 ? 'pass' : 'fail'
    if (result.error) console.error(result.error.message)
    console.log(`<== ${step.name} ${status} ${formatDuration(durationMs)}`)
    return { name: step.name, status, durationMs }
}

function main() {
    const problem = nodeProblem()
    let parsed
    try {
        parsed = parseArgs(process.argv.slice(2))
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
    }
    const head = gitHead()
    const report = {
        head,
        node: process.version,
        mode: parsed.fast ? 'fast' : 'full',
        ok: !problem,
        error: problem,
        steps: []
    }
    if (problem) {
        console.error(problem)
        writeReport(report)
        process.exit(1)
    }
    for (const step of STEPS) {
        if (parsed.skip.has(step.name)) {
            console.log(`\n==> ${step.name} skip (--skip)`)
            report.steps.push({ name: step.name, status: 'skip', durationMs: null })
            continue
        }
        if (parsed.fast && !step.fast) {
            console.log(`\n==> ${step.name} skip (--fast)`)
            report.steps.push({ name: step.name, status: 'skip', durationMs: null })
            continue
        }
        const outcome = runStep(step)
        report.steps.push(outcome)
        if (outcome.status === 'fail') {
            report.ok = false
            report.error = `${step.name} failed`
            for (const later of STEPS.slice(STEPS.indexOf(step) + 1)) {
                report.steps.push({ name: later.name, status: 'not-run', durationMs: null })
            }
            writeReport(report)
            console.error(`\npnpm verify failed at ${step.name}`)
            process.exit(1)
        }
    }
    writeReport(report)
    console.log(`\npnpm verify passed (${report.mode})`)
    console.log(`report ${path.join(REPORT_DIR, 'verify-report.json')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
