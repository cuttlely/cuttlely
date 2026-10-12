// Offline health table: zone lines, production dependencies, boundary edges,
// catalog nodes that have a unit test, and (when asked) an image size.
// The numbers are a report. This process exits 0 when a figure is missing so CI does not fail on them.
// Boundary edge counts come from scripts/check-boundaries.mjs. This file does not count imports itself.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBoundaryMap, matchGlob, trackedFiles, winningSubsystem } from './architecture-map.mjs'
import { collectBoundarySnapshot } from './check-boundaries.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Same extensions the architecture page uses for its line count.
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.css', '.html', '.sql', '.sh'])
const TEST_FILE = /\.(test|spec)\.[^.]+$/
const CATALOG = 'packages/components/nodes/module-catalog.json'

const PREFERRED = [
    ['packages/components', 'Components'],
    ['packages/server', 'Server'],
    ['packages/ui', 'UI'],
    ['packages/chat-widget', 'Chat widget'],
    ['packages/cli', 'CLI']
]

const EXTRA_LABELS = {
    '.': 'Workspace root',
    'packages/api-documentation': 'API documentation'
}

function unquote(value) {
    if (value.length >= 2) {
        const quote = value[0]
        if ((quote === "'" || quote === '"') && value.endsWith(quote)) return value.slice(1, -1)
    }
    return value
}

// pnpm quotes a key that contains parentheses. A tarball version contains colons
// (`xlsx@https://...tgz: {}`), so the separator is the first colon-space, not the first colon.
function splitEntry(body) {
    if (body[0] === "'" || body[0] === '"') {
        const quote = body[0]
        let index = 1
        let key = ''
        while (index < body.length) {
            if (quote === "'" && body[index] === "'" && body[index + 1] === "'") {
                key += "'"
                index += 2
                continue
            }
            if (quote === '"' && body[index] === '\\') {
                key += body[index + 1] || ''
                index += 2
                continue
            }
            if (body[index] === quote) {
                index += 1
                break
            }
            key += body[index]
            index += 1
        }
        let rest = body.slice(index).trim()
        if (rest.startsWith(':')) rest = rest.slice(1).trim()
        return { key, value: unquote(rest) }
    }
    const separator = body.indexOf(': ')
    if (separator !== -1) return { key: body.slice(0, separator).trim(), value: unquote(body.slice(separator + 2).trim()) }
    if (body.endsWith(':')) return { key: body.slice(0, -1).trim(), value: '' }
    return { key: body.trim(), value: '' }
}

export function parseLockfile(text) {
    const importers = new Map()
    const packageKeys = []
    const snapshots = new Map()
    let section = ''
    let importer = null
    let importerField = ''
    let importerDep = ''
    let snapshot = null
    let snapshotField = ''

    for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim() || raw.trimStart().startsWith('#')) continue
        const indent = raw.match(/^ */)?.[0].length ?? 0
        const body = raw.trim()
        if (indent === 0) {
            section = splitEntry(body).key
            importer = null
            snapshot = null
            importerField = ''
            snapshotField = ''
            continue
        }
        if (section === 'importers') {
            if (indent === 2) {
                const { key } = splitEntry(body)
                importer = { dependencies: new Map(), optionalDependencies: new Map() }
                importers.set(key, importer)
                importerField = ''
                importerDep = ''
                continue
            }
            if (!importer) continue
            if (indent === 4) {
                importerField = splitEntry(body).key
                importerDep = ''
                continue
            }
            const prod = importerField === 'dependencies' || importerField === 'optionalDependencies'
            if (!prod) continue
            if (indent === 6) {
                const { key, value } = splitEntry(body)
                importerDep = key
                if (value && value !== '{}') {
                    importer[importerField].set(key, value)
                    importerDep = ''
                }
                continue
            }
            if (indent === 8 && importerDep) {
                const { key, value } = splitEntry(body)
                if (key === 'version') importer[importerField].set(importerDep, value)
            }
            continue
        }
        if (section === 'packages') {
            if (indent === 2) packageKeys.push(splitEntry(body).key)
            continue
        }
        if (section === 'snapshots') {
            if (indent === 2) {
                const { key } = splitEntry(body)
                snapshot = { dependencies: [], optionalDependencies: [] }
                snapshots.set(key, snapshot)
                snapshotField = ''
                continue
            }
            if (!snapshot) continue
            if (indent === 4) {
                snapshotField = splitEntry(body).key
                continue
            }
            if (indent === 6 && (snapshotField === 'dependencies' || snapshotField === 'optionalDependencies')) {
                const { key, value } = splitEntry(body)
                snapshot[snapshotField].push({ name: key, version: value })
            }
        }
    }
    return { importers, packageKeys, snapshots }
}

// `string-width-cjs: string-width@4.2.3` is an alias: the version is already the snapshot id.
function snapshotId(name, version) {
    if (!version || version.startsWith('link:')) return ''
    const head = version.split('(')[0]
    if (head.includes('@')) return version
    return `${name}@${version}`
}

// Peer variants of one package (`name@version(peers)`) are one install.
function nameAtVersion(id) {
    const paren = id.indexOf('(')
    return paren === -1 ? id : id.slice(0, paren)
}

function isLink(version) {
    return String(version).startsWith('link:')
}

function directCount(importer) {
    let count = 0
    for (const version of importer.dependencies.values()) if (!isLink(version)) count += 1
    for (const version of importer.optionalDependencies.values()) if (!isLink(version)) count += 1
    return count
}

// A package closure stays inside that importer. A workspace link is the server
// depending on components or the UI; following it would report the whole workspace
// as the server. The workspace closure is the union of every importer.
function closureSize(lock, starts) {
    const seen = new Set()
    const seenSnap = new Set()
    const seenImp = new Set()
    const importerQueue = [...starts]
    const snapshotQueue = []

    function note(id) {
        if (!id) return
        seen.add(nameAtVersion(id))
        if (seenSnap.has(id) || !lock.snapshots.has(id)) return
        seenSnap.add(id)
        snapshotQueue.push(id)
    }

    while (importerQueue.length || snapshotQueue.length) {
        if (importerQueue.length) {
            const name = importerQueue.shift()
            if (seenImp.has(name)) continue
            seenImp.add(name)
            const body = lock.importers.get(name)
            if (!body) continue
            for (const field of ['dependencies', 'optionalDependencies']) {
                for (const [dep, version] of body[field]) note(snapshotId(dep, version))
            }
            continue
        }
        const id = snapshotQueue.shift()
        const body = lock.snapshots.get(id)
        for (const field of ['dependencies', 'optionalDependencies']) {
            for (const dep of body[field]) note(snapshotId(dep.name, dep.version))
        }
    }
    return seen.size
}

function labelFor(importer) {
    const preferred = PREFERRED.find(([id]) => id === importer)
    if (preferred) return preferred[1]
    return EXTRA_LABELS[importer] || importer
}

export function productionDependencies(text) {
    const lock = parseLockfile(text)
    const ids = [...lock.importers.keys()]
    const preferredIds = PREFERRED.map(([id]) => id).filter((id) => lock.importers.has(id))
    const rest = ids.filter((id) => !preferredIds.includes(id)).sort((a, b) => labelFor(a).localeCompare(labelFor(b)))
    const packages = [...preferredIds, ...rest].map((importer) => ({
        importer,
        label: labelFor(importer),
        direct: directCount(lock.importers.get(importer)),
        closure: closureSize(lock, [importer])
    }))
    return {
        lockfilePackages: lock.packageKeys.length,
        workspaceClosure: closureSize(lock, ids),
        packages
    }
}

function matchesAny(globs, file) {
    return globs.some((glob) => matchGlob(glob, file))
}

export function zoneOf(file, map) {
    if (matchesAny(map.zones.vendored, file)) return 'vendored'
    const win = winningSubsystem(file, map.subsystems)
    if (win && !win.tie) return 'core'
    if (matchesAny(map.zones.core, file)) return 'core'
    if (matchesAny(map.zones.inherited, file)) return 'inherited'
    return 'other'
}

export function countZoneLines(root, files, map) {
    const zones = {
        core: { files: 0, lines: 0 },
        inherited: { files: 0, lines: 0 },
        vendored: { files: 0, lines: 0 },
        other: { files: 0, lines: 0 }
    }
    for (const file of files) {
        if (!CODE_EXT.has(path.posix.extname(file))) continue
        let text
        try {
            text = fs.readFileSync(path.join(root, file), 'utf8')
        } catch {
            continue
        }
        let lines = 0
        for (const line of text.split(/\r?\n/)) if (line.trim()) lines += 1
        const zone = zones[zoneOf(file, map)]
        zone.files += 1
        zone.lines += lines
    }
    return zones
}

export function nodeUnitTests(root, catalog) {
    const nodes = Array.isArray(catalog?.nodes) ? catalog.nodes : []
    const dirs = new Map()
    let withTests = 0
    for (const node of nodes) {
        if (!node || typeof node.file !== 'string') continue
        const dir = path.posix.dirname(node.file)
        let names = dirs.get(dir)
        if (!names) {
            try {
                names = fs.readdirSync(path.join(root, dir))
            } catch {
                names = []
            }
            dirs.set(dir, names)
        }
        if (names.some((name) => TEST_FILE.test(name))) withTests += 1
    }
    return { nodes: nodes.length, withTests }
}

export function boundaryCounts(root) {
    const snapshot = collectBoundarySnapshot(root)
    const subsystems = [...snapshot.perSubsystem.entries()]
        .map(([name, row]) => ({
            name,
            coreToInherited: row.coreToInherited,
            inheritedToCore: row.inheritedToCore,
            entryPoints: row.entryPoints
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    return {
        codeFiles: snapshot.codeFiles,
        importEdges: snapshot.importEdges,
        r1Packages: snapshot.r1Packages.length,
        r1PackageNames: snapshot.r1Packages,
        r1Edges: snapshot.r1Edges.length,
        r2Edges: snapshot.r2Edges.length,
        r3Edges: snapshot.r3Edges.length,
        r4Entry: snapshot.r4Entry.length,
        r4Edges: snapshot.r4Edges.length,
        r5Edges: snapshot.r5Edges.length,
        inheritedFiles: snapshot.inheritedFiles.length,
        subsystems
    }
}

export function inspectImageBytes(ref) {
    if (!ref) return null
    const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Size}}', ref], {
        encoding: 'utf8',
        timeout: 20000
    })
    if (result.status !== 0) return null
    const bytes = Number(String(result.stdout).trim())
    return Number.isFinite(bytes) ? bytes : null
}

export function formatBytes(bytes) {
    if (bytes == null) return 'not measured'
    const gib = bytes / 1024 ** 3
    return `${gib.toFixed(2)} GiB (${bytes} bytes)`
}

function note(report, label, error) {
    const message = error instanceof Error ? error.message : String(error)
    report.notes.push(`${label}: ${message}`)
}

function gitHead(root) {
    const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    })
    return result.status === 0 ? result.stdout.trim() : ''
}

export function buildHealthReport(root, options = {}) {
    const report = {
        head: gitHead(root),
        dependencies: null,
        zones: null,
        boundaries: null,
        nodes: null,
        image: { ref: options.imageRef || '', bytes: null },
        notes: []
    }
    if (options.unknown) report.notes.push(`ignored argument ${options.unknown}`)
    const lockPath = options.lockfilePath || path.join(root, 'pnpm-lock.yaml')
    try {
        report.dependencies = productionDependencies(fs.readFileSync(lockPath, 'utf8'))
    } catch (error) {
        note(report, 'dependencies', error)
    }
    if (!fs.existsSync(path.join(root, '.git'))) {
        report.notes.push('zones: not a git checkout')
        report.notes.push('boundaries: not a git checkout')
    } else {
        try {
            report.zones = countZoneLines(root, trackedFiles(root), loadBoundaryMap(root))
        } catch (error) {
            note(report, 'zones', error)
        }
        try {
            report.boundaries = boundaryCounts(root)
        } catch (error) {
            note(report, 'boundaries', error)
        }
    }
    try {
        const catalog = JSON.parse(fs.readFileSync(path.join(root, CATALOG), 'utf8'))
        report.nodes = nodeUnitTests(root, catalog)
    } catch (error) {
        note(report, 'nodes', error)
    }
    if (options.imageBytes != null) report.image.bytes = Number(options.imageBytes)
    else if (options.imageRef) report.image.bytes = inspectImageBytes(options.imageRef)
    return report
}

function row(cells) {
    return `| ${cells.join(' | ')} |`
}

export function renderMarkdown(report) {
    const lines = ['### Health report', '']
    if (report.head) lines.push(`Commit \`${report.head}\`.`, '')
    lines.push('#### Production dependencies', '')
    const deps = report.dependencies
    if (!deps) lines.push('Not measured.', '')
    else {
        lines.push(row(['', 'Packages']), row(['---', '---:']))
        lines.push(row(['Workspace production closure', String(deps.workspaceClosure)]))
        lines.push(row(['Lockfile name@version', String(deps.lockfilePackages)]))
        lines.push('')
        lines.push(row(['Package', 'Direct', 'Closure']), row(['---', '---:', '---:']))
        for (const pkg of deps.packages) lines.push(row([pkg.label, String(pkg.direct), String(pkg.closure)]))
        lines.push(
            '',
            'A closure counts production dependencies of that package, including optional dependencies. An alias counts as the package it installs. A workspace link is not followed inside a package row. The workspace closure is the union of every package. Dev dependencies are left out.',
            ''
        )
    }
    lines.push('#### Code lines', '')
    lines.push('Non-blank lines of JavaScript, TypeScript, Python, CSS, HTML, SQL and shell.', '')
    if (!report.zones) lines.push('Not measured.', '')
    else {
        lines.push(row(['Zone', 'Files', 'Lines']), row(['---', '---:', '---:']))
        for (const zone of ['core', 'inherited', 'vendored', 'other']) {
            if (zone === 'other' && report.zones.other.files === 0) continue
            const label = zone[0].toUpperCase() + zone.slice(1)
            lines.push(row([label, String(report.zones[zone].files), String(report.zones[zone].lines)]))
        }
        lines.push('')
    }
    lines.push('#### Boundary edges', '')
    lines.push('Counts from `scripts/check-boundaries.mjs`.', '')
    const edges = report.boundaries
    if (!edges) lines.push('Not measured.', '')
    else {
        lines.push(row(['Rule', 'Count']), row(['---', '---:']))
        lines.push(row(['Code files walked', String(edges.codeFiles)]))
        lines.push(row(['Import edges', String(edges.importEdges)]))
        lines.push(row(['R1 third-party packages', String(edges.r1Packages)]))
        lines.push(row(['R1 other harness and pipeline imports', String(edges.r1Edges)]))
        lines.push(row(['R2 outside-package imports', String(edges.r2Edges)]))
        lines.push(row(['R3 core to inherited', String(edges.r3Edges)]))
        lines.push(row(['R4 inherited to core via entry points', String(edges.r4Entry)]))
        lines.push(row(['R4 inherited to core recorded', String(edges.r4Edges)]))
        lines.push(row(['R5 runtime source reads', String(edges.r5Edges)]))
        lines.push(row(['R6 inherited files', String(edges.inheritedFiles)]))
        lines.push('')
        lines.push(row(['Subsystem', 'Core to inherited', 'Inherited to core']), row(['---', '---:', '---:']))
        for (const subsystem of edges.subsystems) {
            lines.push(row([subsystem.name, String(subsystem.coreToInherited), String(subsystem.inheritedToCore)]))
        }
        lines.push('')
    }
    lines.push('#### Node unit tests', '')
    if (!report.nodes) lines.push('Not measured.', '')
    else {
        lines.push(row(['Catalog nodes', 'With a unit test']), row(['---:', '---:']))
        lines.push(row([String(report.nodes.nodes), String(report.nodes.withTests)]))
        lines.push('', 'A node has a unit test when its directory contains a `*.test.*` or `*.spec.*` file.', '')
    }
    lines.push('#### Image', '')
    const ref = report.image?.ref || 'local image'
    lines.push(row(['Image', 'Size']), row(['---', '---']))
    lines.push(row([report.image?.ref ? ref : 'not measured', formatBytes(report.image?.bytes)]))
    lines.push('')
    if (report.notes?.length) {
        lines.push('#### Notes', '')
        for (const item of report.notes) lines.push(`- ${item}`)
        lines.push('')
    }
    return `${lines.join('\n')}\n`
}

export function renderJson(report) {
    return `${JSON.stringify(report, null, 2)}\n`
}

function parseArgs(argv) {
    const options = { root: ROOT, json: false, imageRef: process.env.CUTTLELY_HEALTH_IMAGE || '', help: false }
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--json') options.json = true
        else if (arg === '--help' || arg === '-h') options.help = true
        else if (arg === '--image') options.imageRef = argv[(i += 1)] || ''
        else if (arg === '--root') options.root = path.resolve(argv[(i += 1)] || '')
        else if (arg === '--lockfile') options.lockfilePath = path.resolve(argv[(i += 1)] || '')
        else if (arg === '--image-bytes') options.imageBytes = Number(argv[(i += 1)])
        else options.unknown = arg
    }
    return options
}

function main() {
    try {
        const options = parseArgs(process.argv.slice(2))
        if (options.help) {
            process.stdout.write('node scripts/health-report.mjs [--json] [--image <ref>] [--root <dir>] [--lockfile <path>]\n')
            process.stdout.write('Prints a health table. The process exits 0 even when a figure is missing.\n')
            process.exit(0)
        }
        const report = buildHealthReport(options.root, options)
        const markdown = renderMarkdown(report)
        process.stdout.write(options.json ? renderJson(report) : markdown)
        const summary = process.env.GITHUB_STEP_SUMMARY
        if (summary) fs.appendFileSync(summary, markdown)
    } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error)
        process.stderr.write(`health report failed: ${message}\n`)
    }
    process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
