// Fails when a new import crosses a module boundary, or when a new file under an
// inherited path is not assigned to a subsystem. Crossings that already exist are
// recorded in architecture/boundary-baseline.json and can only shrink.
// architecture/inherited-files.txt is the tracked inherited-file list.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBoundaryMap, matchGlob, trackedFiles, winningSubsystem } from './architecture-map.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_FILE = 'architecture/boundary-baseline.json'
const INHERITED_FILE = 'architecture/inherited-files.txt'
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const TEXT_EXT = new Set([...CODE_EXT, '.py', '.sh'])
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const BUILTINS = new Set(builtinModules)

// These scripts are the ones allowed to read the vendored runtime tree.
const R5_ALLOW = new Set([
    'scripts/vendor-hermes.mjs',
    'scripts/start-cuttlely.sh',
    'scripts/setup-hermes.sh',
    'scripts/cuttlely-hermes-api.py',
    // The git-config proof imports the vendored runtime and runs its git helpers.
    'scripts/hermes-git-config.py',
    'scripts/hermes-git-config.test.mjs',
    // The tool error preview test runs the run stream's preview function from the vendored runtime.
    'scripts/hermes-tool-error-preview.test.mjs',
    // The analyst scope test loads the runtime's MCP argument helper.
    'scripts/hermes-analyst-scope.test.mjs'
])

// The checker names runtime paths in its own rule. It does not load that tree.
const R5_SELF = new Set(['scripts/check-boundaries.mjs', 'scripts/check-boundaries.test.mjs'])

const RUNTIME_DIR = 'hermes'

function matchesAny(globs, file) {
    return globs.some((glob) => matchGlob(glob, file))
}

function under(file, dir) {
    return file === dir || file.startsWith(`${dir}/`)
}

function isRuntimeEngine(file) {
    return under(file, 'packages/harness') || under(file, 'packages/etl') || under(file, 'harness') || under(file, 'etl')
}

function runtimeImportAllowed(target) {
    if (!target) return false
    if (under(target, 'packages/harness') || under(target, 'packages/etl')) return true
    if (under(target, 'packages')) return false
    return under(target, 'harness') || under(target, 'etl') || under(target, 'scripts')
}

function isBuiltin(spec) {
    if (spec.startsWith('node:')) return true
    return BUILTINS.has(spec.split('/')[0])
}

function packageNameOf(spec) {
    if (spec.startsWith('@')) {
        const [scope, name] = spec.split('/')
        return name ? `${scope}/${name}` : spec
    }
    return spec.split('/')[0]
}

export function extractSpecifiers(source) {
    const specs = []
    const n = source.length
    let i = 0

    const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
    const isIdent = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$'

    function atKeyword(word) {
        if (!source.startsWith(word, i)) return false
        if (i > 0 && isIdent(source[i - 1])) return false
        const after = source[i + word.length]
        if (after && isIdent(after)) return false
        return true
    }

    function skipWsComments() {
        for (;;) {
            while (i < n && isWs(source[i])) i += 1
            if (source[i] === '/' && source[i + 1] === '/') {
                i += 2
                while (i < n && source[i] !== '\n') i += 1
                continue
            }
            if (source[i] === '/' && source[i + 1] === '*') {
                i += 2
                while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
                i = Math.min(n, i + 2)
                continue
            }
            return
        }
    }

    function readString() {
        const q = source[i]
        if (q !== "'" && q !== '"' && q !== '`') return undefined
        let value = ''
        i += 1
        if (q === '`') {
            let depth = 0
            let literal = true
            while (i < n) {
                if (source[i] === '\\') {
                    if (depth === 0) value += source[i + 1] || ''
                    i += 2
                    continue
                }
                if (depth === 0 && source[i] === '`') {
                    i += 1
                    return literal ? value : undefined
                }
                if (source[i] === '$' && source[i + 1] === '{') {
                    literal = false
                    depth += 1
                    i += 2
                    continue
                }
                if (depth > 0 && source[i] === '{') {
                    depth += 1
                    i += 1
                    continue
                }
                if (depth > 0 && source[i] === '}') {
                    depth -= 1
                    i += 1
                    continue
                }
                if (depth === 0) value += source[i]
                i += 1
            }
            return undefined
        }
        while (i < n) {
            if (source[i] === '\\') {
                const next = source[i + 1]
                value += next || ''
                i += 2
                continue
            }
            if (source[i] === q) {
                i += 1
                return value
            }
            if (source[i] === '\n') return undefined
            value += source[i]
            i += 1
        }
        return undefined
    }

    function skipString() {
        const q = source[i]
        if (q !== "'" && q !== '"' && q !== '`') return
        const start = i
        const value = readString()
        if (value === undefined && i === start) i += 1
    }

    function skipBalancedParen() {
        if (source[i] !== '(') return false
        let depth = 0
        while (i < n) {
            const c = source[i]
            if (c === "'" || c === '"' || c === '`') {
                skipString()
                continue
            }
            if (c === '/' && source[i + 1] === '/') {
                i += 2
                while (i < n && source[i] !== '\n') i += 1
                continue
            }
            if (c === '/' && source[i + 1] === '*') {
                i += 2
                while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
                i = Math.min(n, i + 2)
                continue
            }
            if (c === '(') depth += 1
            else if (c === ')') {
                depth -= 1
                i += 1
                if (depth === 0) return true
                continue
            }
            i += 1
        }
        return false
    }

    function readFromClause() {
        let depth = 0
        const start = i
        while (i < n && i - start < 8000) {
            skipWsComments()
            if (i >= n) return
            const c = source[i]
            if (c === '{' || c === '(' || c === '[') {
                depth += 1
                i += 1
                continue
            }
            if (c === '}' || c === ')' || c === ']') {
                depth = Math.max(0, depth - 1)
                i += 1
                continue
            }
            if (c === "'" || c === '"' || c === '`') {
                skipString()
                continue
            }
            if (depth === 0 && atKeyword('from')) {
                i += 4
                skipWsComments()
                const spec = readString()
                if (spec) specs.push(spec)
                return
            }
            if (
                depth === 0 &&
                (atKeyword('import') ||
                    atKeyword('export') ||
                    atKeyword('const') ||
                    atKeyword('let') ||
                    atKeyword('var') ||
                    atKeyword('function') ||
                    atKeyword('class') ||
                    atKeyword('return') ||
                    atKeyword('require'))
            ) {
                return
            }
            if (depth === 0 && c === ';') {
                i += 1
                return
            }
            if (depth === 0 && c === '\n') {
                const save = i
                i += 1
                skipWsComments()
                if (atKeyword('from') || source[i] === '{' || source[i] === '*' || source[i] === ',') continue
                i = save + 1
                return
            }
            i += 1
        }
    }

    while (i < n) {
        const c = source[i]
        if (isWs(c)) {
            i += 1
            continue
        }
        if (c === '/' && source[i + 1] === '/') {
            i += 2
            while (i < n && source[i] !== '\n') i += 1
            continue
        }
        if (c === '/' && source[i + 1] === '*') {
            i += 2
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
            i = Math.min(n, i + 2)
            continue
        }
        if (c === "'" || c === '"' || c === '`') {
            skipString()
            continue
        }
        if (atKeyword('import')) {
            const after = source[i + 6]
            if (after === '.') {
                i += 6
                continue
            }
            i += 6
            skipWsComments()
            if (source[i] === '(') {
                i += 1
                skipWsComments()
                const spec = readString()
                if (spec) specs.push(spec)
                continue
            }
            if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
                const spec = readString()
                if (spec) specs.push(spec)
                continue
            }
            readFromClause()
            continue
        }
        if (atKeyword('export')) {
            i += 6
            readFromClause()
            continue
        }
        if (atKeyword('createRequire')) {
            i += 'createRequire'.length
            skipWsComments()
            if (source[i] === '(' && skipBalancedParen()) {
                skipWsComments()
                if (source[i] === '(') {
                    i += 1
                    skipWsComments()
                    const spec = readString()
                    if (spec) specs.push(spec)
                }
            }
            continue
        }
        if (atKeyword('require')) {
            i += 7
            skipWsComments()
            if (source[i] === '.') {
                i += 1
                skipWsComments()
                if (source.startsWith('resolve', i) && !isIdent(source[i + 7] || '')) {
                    i += 7
                    skipWsComments()
                }
            }
            if (source[i] === '(') {
                i += 1
                skipWsComments()
                const spec = readString()
                if (spec) specs.push(spec)
            }
            continue
        }
        i += 1
    }
    return specs
}

export function stringLiterals(source) {
    const values = []
    const n = source.length
    let i = 0
    while (i < n) {
        const c = source[i]
        if (c === '/' && source[i + 1] === '/') {
            i += 2
            while (i < n && source[i] !== '\n') i += 1
            continue
        }
        if (c === '/' && source[i + 1] === '*') {
            i += 2
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
            i = Math.min(n, i + 2)
            continue
        }
        if (c === "'" || c === '"' || c === '`') {
            const q = c
            i += 1
            let value = ''
            let literal = true
            let depth = 0
            while (i < n) {
                if (source[i] === '\\') {
                    if (depth === 0 && q !== '`') value += source[i + 1] || ''
                    else if (depth === 0) value += source[i + 1] || ''
                    i += 2
                    continue
                }
                if (q === '`' && source[i] === '$' && source[i + 1] === '{') {
                    literal = false
                    depth += 1
                    i += 2
                    continue
                }
                if (q === '`' && depth > 0 && source[i] === '{') {
                    depth += 1
                    i += 1
                    continue
                }
                if (q === '`' && depth > 0 && source[i] === '}') {
                    depth -= 1
                    i += 1
                    continue
                }
                if (depth === 0 && source[i] === q) {
                    i += 1
                    if (literal && value) values.push(value)
                    break
                }
                if (q !== '`' && source[i] === '\n') break
                if (depth === 0) value += source[i]
                i += 1
            }
            continue
        }
        if (c === '#') {
            // Shell and Python comments. A hash inside JS is a private specifier, not a comment,
            // so only treat a hash at the start of a line as a comment.
            const lineStart = i === 0 || source[i - 1] === '\n'
            if (lineStart) {
                while (i < n && source[i] !== '\n') i += 1
                continue
            }
        }
        i += 1
    }
    return values
}

function resolveExisting(rel, fileSet) {
    if (!rel || rel.startsWith('..') || rel.startsWith('/')) return null
    const bases = [rel]
    if (/\.(js|mjs|cjs|jsx)$/.test(rel)) {
        const stem = rel.replace(/\.(js|mjs|cjs|jsx)$/, '')
        bases.push(stem, `${stem}.ts`, `${stem}.tsx`)
    }
    if (rel.endsWith('.d.ts')) bases.push(rel.slice(0, -5), `${rel.slice(0, -5)}.ts`)
    for (const base of bases) {
        if (fileSet.has(base)) return base
        for (const ext of EXTS) {
            if (fileSet.has(base + ext)) return base + ext
        }
        for (const ext of EXTS) {
            const index = `${base}/index${ext}`
            if (fileSet.has(index)) return index
        }
    }
    return null
}

function mapDistToSrc(rel) {
    return rel
        .replace('/dist/src/', '/src/')
        .replace('/dist/', '/src/')
        .replace(/\.d\.ts$/, '')
        .replace(/\.(js|mjs|cjs|jsx)$/, '')
}

function exportTarget(value) {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value.default || value.import || value.require || value.types || null
}

function loadPackages(root, files) {
    const pkgs = []
    for (const file of files) {
        if (file !== 'package.json' && !file.endsWith('/package.json')) continue
        if (file.includes('node_modules/')) continue
        let json
        try {
            json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
        } catch {
            continue
        }
        if (!json || typeof json.name !== 'string' || !json.name) continue
        const dir = path.posix.dirname(file)
        pkgs.push({ name: json.name, dir: dir === '.' ? '' : dir, json })
    }
    pkgs.sort((a, b) => b.name.length - a.name.length)
    return pkgs
}

function loadAliases(root, files) {
    const aliases = []
    for (const file of files) {
        if (!/^packages\/[^/]+\/(?:tsconfig|jsconfig)\.json$/.test(file)) continue
        let json
        try {
            json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
        } catch {
            continue
        }
        const paths = json.compilerOptions?.paths
        if (!paths) continue
        const pkgDir = path.posix.dirname(file)
        for (const [key, values] of Object.entries(paths)) {
            if (!key.endsWith('/*') || !Array.isArray(values) || typeof values[0] !== 'string' || !values[0].endsWith('/*')) continue
            aliases.push({
                pkgDir,
                specPrefix: key.slice(0, -1),
                targetPrefix: path.posix.normalize(path.posix.join(pkgDir, values[0].slice(0, -2)))
            })
        }
    }
    return aliases
}

function resolvePackageSubpath(pkg, sub, fileSet) {
    const targets = []
    const exportsField = pkg.json.exports
    if (sub === '.') {
        if (exportsField && typeof exportsField === 'object') {
            const dot = exportTarget(exportsField['.'])
            if (dot) targets.push(dot)
        }
        if (typeof pkg.json.module === 'string') targets.push(pkg.json.module)
        if (typeof pkg.json.main === 'string') targets.push(pkg.json.main)
    } else if (exportsField && typeof exportsField === 'object') {
        const hit = exportTarget(exportsField[sub])
        if (hit) targets.push(hit)
        targets.push(sub.slice(2))
    } else {
        targets.push(sub.slice(2))
    }
    for (const target of targets) {
        if (typeof target !== 'string' || target.startsWith('..')) continue
        const rel = path.posix.normalize(path.posix.join(pkg.dir, target))
        const found = resolveExisting(rel, fileSet) || resolveExisting(mapDistToSrc(rel), fileSet)
        if (found) return found
    }
    const fallback = pkg.dir ? `${pkg.dir}/package.json` : 'package.json'
    return fileSet.has(fallback) ? fallback : null
}

function resolveWorkspace(spec, packages, fileSet) {
    for (const pkg of packages) {
        if (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`)) continue
        const sub = spec === pkg.name ? '.' : `./${spec.slice(pkg.name.length + 1)}`
        return resolvePackageSubpath(pkg, sub, fileSet)
    }
    return null
}

function resolveAlias(fromFile, spec, aliases, fileSet) {
    let best = null
    for (const alias of aliases) {
        if (!spec.startsWith(alias.specPrefix)) continue
        if (alias.pkgDir && !under(fromFile, alias.pkgDir)) continue
        if (!best || alias.pkgDir.length > best.pkgDir.length) best = alias
    }
    if (!best) return null
    const rest = spec.slice(best.specPrefix.length)
    const rel = path.posix.normalize(path.posix.join(best.targetPrefix, rest))
    return resolveExisting(rel, fileSet)
}

function resolveSpecifier(fromFile, spec, ctx) {
    const clean = spec.split('?')[0].split('#')[0]
    if (
        !clean ||
        clean.startsWith('node:') ||
        isBuiltin(clean) ||
        clean.startsWith('data:') ||
        clean.startsWith('http:') ||
        clean.startsWith('https:')
    ) {
        return { kind: 'builtin' }
    }
    if (clean.startsWith('.')) {
        const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean))
        return { kind: 'file', file: resolveExisting(rel, ctx.fileSet), rel }
    }
    if (clean.startsWith('@/') || clean.startsWith('@test-utils/')) {
        const file = resolveAlias(fromFile, clean, ctx.aliases, ctx.fileSet)
        return file ? { kind: 'file', file, rel: file } : { kind: 'unresolved', spec: clean }
    }
    const workspace = resolveWorkspace(clean, ctx.packages, ctx.fileSet)
    if (workspace) return { kind: 'file', file: workspace, rel: workspace }
    if (clean.startsWith('@') || /^[a-zA-Z]/.test(clean)) return { kind: 'package', name: packageNameOf(clean), spec: clean }
    return { kind: 'unresolved', spec: clean }
}

function classify(file, map, cache) {
    const hit = cache.get(file)
    if (hit) return hit
    let info
    if (matchesAny(map.zones.vendored, file)) info = { zone: 'vendored', subsystem: 'Agent runtime' }
    else {
        const win = winningSubsystem(file, map.subsystems)
        if (win?.tie) info = { zone: 'tie', subsystem: null }
        else if (win) info = { zone: 'core', subsystem: win.name }
        else if (matchesAny(map.zones.inherited, file)) info = { zone: 'inherited', subsystem: null }
        else info = { zone: 'none', subsystem: null }
    }
    cache.set(file, info)
    return info
}

function edgeKey(edge) {
    return `${edge.from}\0${edge.to}`
}

function sortEdges(edges) {
    return [...edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))
}

function samePackage(file, target, pkgDir) {
    return under(file, pkgDir) && under(target, pkgDir)
}

function literalIsRead(source, value) {
    let from = 0
    while (from < source.length) {
        const at = source.indexOf(value, from)
        if (at < 0) return false
        const before = source.slice(Math.max(0, at - 120), at)
        if (
            /\b(readFileSync|readFile|existsSync|statSync|lstatSync|createReadStream|openSync|accessSync|import|require|read)\s*\(/.test(
                before
            )
        ) {
            return true
        }
        from = at + value.length
    }
    return false
}

function runtimeReads(file, source, runtimeFiles) {
    const reads = []
    if (CODE_EXT.has(path.posix.extname(file)) || file === 'Dockerfile') {
        for (const value of stringLiterals(source)) {
            if (runtimeFiles.has(value) && literalIsRead(source, value)) reads.push(value)
        }
        if (CODE_EXT.has(path.posix.extname(file)) && /path\.join\(\s*(?:ROOT|root)\s*,\s*['"]hermes['"]\s*\)/.test(source)) {
            reads.push(`${RUNTIME_DIR}/`)
        }
    }
    if (file.endsWith('.py')) {
        const stripped = source
            .split('\n')
            .map((line) => (line.trimStart().startsWith('#') ? '' : line))
            .join('\n')
        if (/ROOT\s*\/\s*['"]hermes['"]/.test(stripped)) reads.push(`${RUNTIME_DIR}/`)
        for (const match of stripped.matchAll(/hermes\/[A-Za-z0-9_@.+/-]+/g)) {
            const token = match[0].replace(/[),;:]+$/, '')
            if (runtimeFiles.has(token)) reads.push(token)
        }
    }
    if (file.endsWith('.sh') || file === 'Dockerfile') {
        const stripped = source
            .split('\n')
            .map((line) => (line.trimStart().startsWith('#') ? '' : line))
            .join('\n')
        for (const match of stripped.matchAll(/hermes\/[A-Za-z0-9_@.+/-]+/g)) {
            const token = match[0].replace(/[),;:'"]+$/, '')
            if (runtimeFiles.has(token)) reads.push(token)
        }
    }
    return [...new Set(reads)]
}

function emptyDependencies(pkg) {
    if (!pkg || pkg.dependencies == null) return true
    if (typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) return false
    return Object.keys(pkg.dependencies).length === 0
}

export function collectBoundarySnapshot(root = ROOT, files = trackedFiles(root)) {
    const map = loadBoundaryMap(root)
    const fileSet = new Set(files)
    const packages = loadPackages(root, files)
    const aliases = loadAliases(root, files)
    const ctx = { fileSet, packages, aliases }
    const cache = new Map()
    const entryPoints = new Set()
    for (const subsystem of map.subsystems) {
        for (const entry of subsystem.entryPoints) entryPoints.add(entry)
    }
    const runtimeFiles = new Set(files.filter((file) => under(file, RUNTIME_DIR)))

    const r1Packages = new Set()
    const r1PackageEdges = []
    const r1Edges = []
    const r2Edges = []
    const r3Edges = []
    const r4Edges = []
    const r4Entry = []
    const r5Edges = []
    const seen = new Set()
    let importEdges = 0
    let codeFiles = 0
    const perSubsystem = new Map()
    for (const subsystem of map.subsystems) {
        perSubsystem.set(subsystem.name, { coreToInherited: 0, inheritedToCore: 0, entryPoints: 0 })
    }

    function addEdge(list, edge, bucket) {
        const key = `${bucket}\0${edgeKey(edge)}`
        if (seen.has(key)) return
        seen.add(key)
        list.push(edge)
    }

    function bump(name, field) {
        const row = perSubsystem.get(name)
        if (row) row[field] += 1
    }

    const isolated = [
        ['packages/chat-widget', 'packages/chat-widget/package.json'],
        ['packages/cli', 'packages/cli/package.json']
    ]
    const dependencyViolations = []
    for (const [dir, pkgFile] of isolated) {
        if (!fileSet.has(pkgFile)) continue
        let pkg
        try {
            pkg = JSON.parse(fs.readFileSync(path.join(root, pkgFile), 'utf8'))
        } catch {
            dependencyViolations.push({
                rule: 'R2',
                from: pkgFile,
                to: pkgFile,
                message: `R2: ${pkgFile} is not valid JSON, so its dependencies cannot be checked.\nFix: keep the dependencies field empty.`
            })
            continue
        }
        if (!emptyDependencies(pkg)) {
            dependencyViolations.push({
                rule: 'R2',
                from: pkgFile,
                to: pkgFile,
                message: [
                    `R2: ${pkgFile} dependencies is not empty.`,
                    'packages/chat-widget and packages/cli keep an empty dependencies field.',
                    'Fix: delete the dependencies entries. Dev dependencies used by the build or the tests are separate.'
                ].join('\n')
            })
        }
    }

    for (const file of files) {
        if (under(file, RUNTIME_DIR)) continue
        const ext = path.posix.extname(file)
        const readable = TEXT_EXT.has(ext) || file === 'Dockerfile'
        if (!readable) continue
        let source
        try {
            source = fs.readFileSync(path.join(root, file), 'utf8')
        } catch {
            continue
        }
        if (!R5_ALLOW.has(file) && !R5_SELF.has(file)) {
            for (const target of runtimeReads(file, source, runtimeFiles)) {
                addEdge(r5Edges, { from: file, to: target }, 'r5')
            }
        }
        if (!CODE_EXT.has(ext)) continue
        codeFiles += 1
        const sourceInfo = classify(file, map, cache)
        const inRuntimeEngines = isRuntimeEngine(file)
        const isolatedDir = under(file, 'packages/chat-widget') ? 'packages/chat-widget' : under(file, 'packages/cli') ? 'packages/cli' : ''
        for (const spec of extractSpecifiers(source)) {
            importEdges += 1
            const resolved = resolveSpecifier(file, spec, ctx)
            if (resolved.kind === 'builtin') continue
            const target = resolved.file || resolved.rel || ''
            if (inRuntimeEngines) {
                const allowedPlace = runtimeImportAllowed(target)
                if (resolved.kind === 'package') {
                    r1Packages.add(resolved.name)
                    addEdge(r1PackageEdges, { from: file, to: resolved.name }, 'r1pkg')
                } else if (!allowedPlace) addEdge(r1Edges, { from: file, to: target || spec }, 'r1')
            }
            if (isolatedDir) {
                const inside = target && samePackage(file, target, isolatedDir)
                if (!inside) addEdge(r2Edges, { from: file, to: target || spec }, 'r2')
            }
            if (!target || target === file) continue
            const targetInfo = classify(target, map, cache)
            if (targetInfo.zone === 'vendored' || under(target, RUNTIME_DIR)) {
                if (!R5_ALLOW.has(file) && !R5_SELF.has(file)) addEdge(r5Edges, { from: file, to: target }, 'r5')
                continue
            }
            if (sourceInfo.zone === 'core' && targetInfo.zone === 'inherited') {
                addEdge(r3Edges, { from: file, to: target }, 'r3')
                bump(sourceInfo.subsystem, 'coreToInherited')
            } else if (sourceInfo.zone === 'inherited' && targetInfo.zone === 'core') {
                if (entryPoints.has(target)) {
                    addEdge(r4Entry, { from: file, to: target }, 'r4entry')
                    bump(targetInfo.subsystem, 'entryPoints')
                    bump(targetInfo.subsystem, 'inheritedToCore')
                } else {
                    addEdge(r4Edges, { from: file, to: target }, 'r4')
                    bump(targetInfo.subsystem, 'inheritedToCore')
                }
            }
        }
    }

    const inheritedFiles = files.filter((file) => classify(file, map, cache).zone === 'inherited').sort()

    return {
        map,
        importEdges,
        codeFiles,
        r1Packages: [...r1Packages].sort(),
        r1PackageEdges: sortEdges(r1PackageEdges),
        r1Edges: sortEdges(r1Edges),
        r2Edges: sortEdges(r2Edges),
        r3Edges: sortEdges(r3Edges),
        r4Edges: sortEdges(r4Edges),
        r4Entry: sortEdges(r4Entry),
        r5Edges: sortEdges(r5Edges),
        inheritedFiles,
        dependencyViolations,
        perSubsystem
    }
}

function asEdge(value) {
    if (!value || typeof value.from !== 'string' || typeof value.to !== 'string') return null
    const edge = { from: value.from, to: value.to }
    if (typeof value.reason === 'string' && value.reason.trim()) edge.reason = value.reason.trim()
    return edge
}

function asPackage(value) {
    if (typeof value === 'string') return { name: value }
    if (!value || typeof value.name !== 'string') return null
    const item = { name: value.name }
    if (typeof value.reason === 'string' && value.reason.trim()) item.reason = value.reason.trim()
    return item
}

export function loadBaseline(root = ROOT) {
    const baselinePath = path.join(root, BASELINE_FILE)
    const inheritedPath = path.join(root, INHERITED_FILE)
    if (!fs.existsSync(baselinePath) || !fs.existsSync(inheritedPath)) return null
    const json = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    const inherited = fs
        .readFileSync(inheritedPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    const edges = (list) => (Array.isArray(list) ? list.map(asEdge).filter(Boolean) : [])
    const packages = Array.isArray(json.r1Packages) ? json.r1Packages.map(asPackage).filter(Boolean) : []
    const additions = Array.isArray(json.r6Additions) ? json.r6Additions : []
    return {
        r1Packages: packages,
        r1Edges: edges(json.r1Edges),
        r2Edges: edges(json.r2Edges),
        r3Edges: edges(json.r3Edges),
        r4Edges: edges(json.r4Edges),
        r5Edges: edges(json.r5Edges),
        r6Additions: additions
            .filter((item) => item && typeof item.path === 'string')
            .map((item) => ({ path: item.path, ...(item.reason ? { reason: String(item.reason) } : {}) })),
        inherited
    }
}

function packageNames(list) {
    return new Set(list.map((item) => (typeof item === 'string' ? item : item.name)))
}

function addedEdges(current, recorded) {
    const known = new Set(recorded.map(edgeKey))
    return current.filter((edge) => !known.has(edgeKey(edge)))
}

function removedEdges(current, recorded) {
    const known = new Set(current.map(edgeKey))
    return recorded.filter((edge) => !known.has(edgeKey(edge)))
}

function fixUpdate(kind) {
    return `Fix: node scripts/check-boundaries.mjs --update --allow-new "why this ${kind} stays". --update alone only shrinks the baseline.`
}

function fixShrink() {
    return 'Fix: run node scripts/check-boundaries.mjs --update to shrink the list.'
}

function violationsFor(snapshot, baseline) {
    const violations = [...snapshot.dependencyViolations]
    if (!baseline) {
        violations.push({
            rule: 'baseline',
            from: BASELINE_FILE,
            to: INHERITED_FILE,
            message: [
                `Missing ${BASELINE_FILE} or ${INHERITED_FILE}.`,
                'These files record the crossings and inherited files that exist today.',
                'Fix: restore them from git. Do not start a new list to hide a crossing.'
            ].join('\n')
        })
        return violations
    }
    const allowedPackages = packageNames(baseline.r1Packages)
    for (const edge of snapshot.r1PackageEdges) {
        if (allowedPackages.has(edge.to)) continue
        violations.push({
            rule: 'R1',
            from: edge.from,
            to: edge.to,
            message: [
                `R1: ${edge.from} imports ${edge.to}, which is not in ${BASELINE_FILE}.`,
                'packages/harness and packages/etl may import node builtins, the recorded third-party packages, each other, and helpers in scripts/. They do not import other paths under packages/.',
                fixUpdate('package')
            ].join('\n')
        })
    }
    for (const edge of addedEdges(snapshot.r1Edges, baseline.r1Edges)) {
        const intoPackages = under(edge.to, 'packages')
        violations.push({
            rule: 'R1',
            from: edge.from,
            to: edge.to,
            message: intoPackages
                ? [
                      `R1: ${edge.from} imports ${edge.to}.`,
                      'packages/harness and packages/etl do not import other paths under packages/. They may import node builtins, the recorded third-party packages, each other, and helpers in scripts/.',
                      'Fix: delete this import. Call the other side through a helper in scripts/ or over HTTP.'
                  ].join('\n')
                : [
                      `R1: ${edge.from} imports ${edge.to}.`,
                      'packages/harness and packages/etl may import node builtins, the recorded third-party packages, each other, and helpers in scripts/. They do not import other paths under packages/.',
                      fixUpdate('import')
                  ].join('\n')
        })
    }
    for (const edge of addedEdges(snapshot.r2Edges, baseline.r2Edges)) {
        violations.push({
            rule: 'R2',
            from: edge.from,
            to: edge.to,
            message: [
                `R2: ${edge.from} imports ${edge.to}, which is outside its package.`,
                'packages/chat-widget and packages/cli import nothing outside their own package, and their dependencies stay empty.',
                'Fix: delete this import.'
            ].join('\n')
        })
    }
    for (const edge of addedEdges(snapshot.r3Edges, baseline.r3Edges)) {
        violations.push({
            rule: 'R3',
            from: edge.from,
            to: edge.to,
            message: [
                `R3: ${edge.from} imports ${edge.to}.`,
                `Core modules may import an inherited file only when that pair is recorded in ${BASELINE_FILE}.`,
                fixUpdate('edge')
            ].join('\n')
        })
    }
    for (const edge of addedEdges(snapshot.r4Edges, baseline.r4Edges)) {
        violations.push({
            rule: 'R4',
            from: edge.from,
            to: edge.to,
            message: [
                `R4: ${edge.from} imports ${edge.to}.`,
                "Inherited files may import a core module only through that subsystem's entryPoints, or through a pair recorded in " +
                    `${BASELINE_FILE}.`,
                'Fix: import an entry point of that subsystem from architecture/boundaries.json. To record this pair instead, run node scripts/check-boundaries.mjs --update --allow-new "why this edge stays".'
            ].join('\n')
        })
    }
    for (const edge of addedEdges(snapshot.r5Edges, baseline.r5Edges)) {
        violations.push({
            rule: 'R5',
            from: edge.from,
            to: edge.to,
            message: [
                `R5: ${edge.from} reads ${edge.to}.`,
                'Files outside hermes/ do not read the agent runtime source. Harness code talks to the runtime over HTTP.',
                'The scripts that may read it are scripts/vendor-hermes.mjs, scripts/start-cuttlely.sh, scripts/setup-hermes.sh, scripts/cuttlely-hermes-api.py, scripts/hermes-git-config.py, scripts/hermes-git-config.test.mjs, scripts/hermes-tool-error-preview.test.mjs, and scripts/hermes-analyst-scope.test.mjs.',
                'Fix: delete the read and call the runtime over HTTP.'
            ].join('\n')
        })
    }
    const inheritedKnown = new Set(baseline.inherited)
    const inheritedNow = new Set(snapshot.inheritedFiles)
    for (const file of snapshot.inheritedFiles) {
        if (inheritedKnown.has(file)) continue
        violations.push({
            rule: 'R6',
            from: file,
            to: file,
            message: [
                `R6: ${file} is under an inherited path, is not listed in ${INHERITED_FILE}, and is not assigned to a subsystem.`,
                'Fix: add its path to a subsystem, or to core-shared, in architecture/boundaries.json.',
                fixUpdate('file')
            ].join('\n')
        })
    }
    for (const file of baseline.inherited) {
        if (inheritedNow.has(file)) continue
        violations.push({
            rule: 'stale',
            from: file,
            to: file,
            message: [
                `Stale inherited file: ${file} is listed in ${INHERITED_FILE} but is not an inherited file in this tree.`,
                fixShrink()
            ].join('\n')
        })
    }
    const staleEdges = [
        ['R1', removedEdges(snapshot.r1Edges, baseline.r1Edges)],
        ['R2', removedEdges(snapshot.r2Edges, baseline.r2Edges)],
        ['R3', removedEdges(snapshot.r3Edges, baseline.r3Edges)],
        ['R4', removedEdges(snapshot.r4Edges, baseline.r4Edges)],
        ['R5', removedEdges(snapshot.r5Edges, baseline.r5Edges)]
    ]
    for (const [rule, edges] of staleEdges) {
        for (const edge of edges) {
            violations.push({
                rule: 'stale',
                from: edge.from,
                to: edge.to,
                message: [
                    `Stale ${rule} crossing: ${edge.from} -> ${edge.to} is in ${BASELINE_FILE} but that import is not in this tree.`,
                    fixShrink()
                ].join('\n')
            })
        }
    }
    const usedPackages = new Set(snapshot.r1Packages)
    for (const item of baseline.r1Packages) {
        if (usedPackages.has(item.name)) continue
        violations.push({
            rule: 'stale',
            from: item.name,
            to: item.name,
            message: [
                `Stale R1 package: ${item.name} is in ${BASELINE_FILE} but packages/harness and packages/etl no longer import it.`,
                fixShrink()
            ].join('\n')
        })
    }
    return violations
}

function summaryText(snapshot, violations) {
    const lines = []
    lines.push(`boundaries: ${snapshot.codeFiles} code files, ${snapshot.importEdges} import edges, ${violations.length} violation(s)`)
    lines.push(`R1 third-party packages (${snapshot.r1Packages.length}): ${snapshot.r1Packages.join(', ') || '(none)'}`)
    lines.push(`R1 other harness/etl imports: ${snapshot.r1Edges.length}`)
    lines.push(`R2 outside-package imports: ${snapshot.r2Edges.length}`)
    lines.push(`R3 core -> inherited: ${snapshot.r3Edges.length}`)
    lines.push(`R4 inherited -> core via entry points: ${snapshot.r4Entry.length}`)
    lines.push(`R4 inherited -> core recorded: ${snapshot.r4Edges.length}`)
    lines.push(`R5 runtime source reads: ${snapshot.r5Edges.length}`)
    lines.push(`R6 inherited files: ${snapshot.inheritedFiles.length}`)
    const names = [...snapshot.perSubsystem.keys()].sort()
    for (const name of names) {
        const row = snapshot.perSubsystem.get(name)
        lines.push(
            `${name}: core -> inherited ${row.coreToInherited}, inherited -> core ${row.inheritedToCore} (${row.entryPoints} via entry points)`
        )
    }
    return lines.join('\n')
}

function writeStepSummary(snapshot, violations) {
    const file = process.env.GITHUB_STEP_SUMMARY
    if (!file) return
    const lines = ['### Module boundaries', '', `| Rule | Edges |`, `| --- | ---: |`]
    lines.push(`| R1 third-party packages | ${snapshot.r1Packages.length} |`)
    lines.push(`| R1 other harness/etl imports | ${snapshot.r1Edges.length} |`)
    lines.push(`| R2 outside-package imports | ${snapshot.r2Edges.length} |`)
    lines.push(`| R3 core -> inherited | ${snapshot.r3Edges.length} |`)
    lines.push(`| R4 inherited -> core via entry points | ${snapshot.r4Entry.length} |`)
    lines.push(`| R4 inherited -> core recorded | ${snapshot.r4Edges.length} |`)
    lines.push(`| R5 runtime source reads | ${snapshot.r5Edges.length} |`)
    lines.push(`| R6 inherited files | ${snapshot.inheritedFiles.length} |`)
    lines.push('', `| Subsystem | Core -> inherited | Inherited -> core |`, `| --- | ---: | ---: |`)
    for (const name of [...snapshot.perSubsystem.keys()].sort()) {
        const row = snapshot.perSubsystem.get(name)
        lines.push(`| ${name} | ${row.coreToInherited} | ${row.inheritedToCore} |`)
    }
    if (violations.length) {
        lines.push('', '#### Violations', '')
        for (const violation of violations.slice(0, 30)) lines.push('```', violation.message, '```', '')
        if (violations.length > 30) lines.push(`And ${violations.length - 30} more.`)
    }
    fs.appendFileSync(file, `${lines.join('\n')}\n`)
}

function printViolations(violations) {
    const shown = violations.slice(0, 40)
    for (const violation of shown) console.error(`\n${violation.message}`)
    if (violations.length > shown.length) console.error(`\nAnd ${violations.length - shown.length} more.`)
}

export function checkBoundaries(root = ROOT, files) {
    const snapshot = collectBoundarySnapshot(root, files)
    const baseline = loadBaseline(root)
    const violations = violationsFor(snapshot, baseline)
    return { ok: violations.length === 0, violations, snapshot, baseline }
}

function withReason(edge, reason) {
    if (!reason) return { from: edge.from, to: edge.to }
    return { from: edge.from, to: edge.to, reason }
}

function mergeEdges(current, recorded, reason) {
    const previous = new Map(recorded.map((edge) => [edgeKey(edge), edge]))
    return sortEdges(
        current.map((edge) => {
            const old = previous.get(edgeKey(edge))
            if (old) return old.reason ? { from: edge.from, to: edge.to, reason: old.reason } : { from: edge.from, to: edge.to }
            return withReason(edge, reason)
        })
    )
}

function baselineDocument(snapshot, baseline, reason) {
    const previousPackages = new Map((baseline?.r1Packages || []).map((item) => [item.name, item]))
    const r1Packages = snapshot.r1Packages.map((name) => {
        const old = previousPackages.get(name)
        if (old?.reason) return { name, reason: old.reason }
        if (!old && reason) return { name, reason }
        return { name }
    })
    const previousAdditions = new Map((baseline?.r6Additions || []).map((item) => [item.path, item]))
    const inheritedKnown = new Set(baseline?.inherited || [])
    const r6Additions = []
    for (const file of snapshot.inheritedFiles) {
        const old = previousAdditions.get(file)
        if (old?.reason) r6Additions.push({ path: file, reason: old.reason })
        else if (!inheritedKnown.has(file) && reason) r6Additions.push({ path: file, reason })
    }
    r6Additions.sort((a, b) => a.path.localeCompare(b.path))
    return {
        r1Packages,
        r1Edges: mergeEdges(snapshot.r1Edges, baseline?.r1Edges || [], reason),
        r2Edges: mergeEdges(snapshot.r2Edges, baseline?.r2Edges || [], reason),
        r3Edges: mergeEdges(snapshot.r3Edges, baseline?.r3Edges || [], reason),
        r4Edges: mergeEdges(snapshot.r4Edges, baseline?.r4Edges || [], reason),
        r5Edges: mergeEdges(snapshot.r5Edges, baseline?.r5Edges || [], reason),
        r6Additions
    }
}

function growthOf(snapshot, baseline) {
    const items = []
    if (baseline) {
        const allowed = packageNames(baseline.r1Packages)
        for (const edge of snapshot.r1PackageEdges) if (!allowed.has(edge.to)) items.push(`R1 ${edge.from} -> ${edge.to}`)
        for (const edge of addedEdges(snapshot.r1Edges, baseline.r1Edges)) items.push(`R1 ${edge.from} -> ${edge.to}`)
        for (const edge of addedEdges(snapshot.r2Edges, baseline.r2Edges)) items.push(`R2 ${edge.from} -> ${edge.to}`)
        for (const edge of addedEdges(snapshot.r3Edges, baseline.r3Edges)) items.push(`R3 ${edge.from} -> ${edge.to}`)
        for (const edge of addedEdges(snapshot.r4Edges, baseline.r4Edges)) items.push(`R4 ${edge.from} -> ${edge.to}`)
        for (const edge of addedEdges(snapshot.r5Edges, baseline.r5Edges)) items.push(`R5 ${edge.from} -> ${edge.to}`)
        const known = new Set(baseline.inherited)
        for (const file of snapshot.inheritedFiles) if (!known.has(file)) items.push(`R6 ${file}`)
    }
    return items
}

export function updateBaseline(root, { allowNew = false, reason = '' } = {}) {
    const snapshot = collectBoundarySnapshot(root)
    const baseline = loadBaseline(root)
    const trimmed = typeof reason === 'string' ? reason.trim() : ''
    if (allowNew && !trimmed) {
        return { ok: false, message: 'Pass a reason: --allow-new "why this crossing stays".' }
    }
    if (allowNew && trimmed.includes('\n')) {
        return { ok: false, message: '--allow-new takes a single-line reason.' }
    }
    if (!baseline) {
        return {
            ok: false,
            message: `Missing ${BASELINE_FILE} or ${INHERITED_FILE}. Restore them. --update does not invent a new baseline.`
        }
    }
    const growth = growthOf(snapshot, baseline)
    if (growth.length && !allowNew) {
        const shown = growth
            .slice(0, 40)
            .map((item) => `  ${item}`)
            .join('\n')
        const more = growth.length > 40 ? `\n  And ${growth.length - 40} more.` : ''
        return {
            ok: false,
            message: [
                `The boundary baseline would grow by ${growth.length}. --update only shrinks it.`,
                shown + more,
                'Fix: do not add the crossing. To record one on purpose, run node scripts/check-boundaries.mjs --update --allow-new "reason".'
            ].join('\n')
        }
    }
    const removed =
        removedEdges(snapshot.r1Edges, baseline.r1Edges).length +
        removedEdges(snapshot.r2Edges, baseline.r2Edges).length +
        removedEdges(snapshot.r3Edges, baseline.r3Edges).length +
        removedEdges(snapshot.r4Edges, baseline.r4Edges).length +
        removedEdges(snapshot.r5Edges, baseline.r5Edges).length +
        baseline.r1Packages.filter((item) => !snapshot.r1Packages.includes(item.name)).length +
        baseline.inherited.filter((file) => !snapshot.inheritedFiles.includes(file)).length
    const doc = baselineDocument(snapshot, baseline, allowNew ? trimmed : '')
    fs.mkdirSync(path.dirname(path.join(root, BASELINE_FILE)), { recursive: true })
    fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify(doc, null, 4)}\n`)
    fs.writeFileSync(path.join(root, INHERITED_FILE), `${snapshot.inheritedFiles.join('\n')}\n`)
    return {
        ok: true,
        message: `boundaries: baseline updated, removed ${removed}, added ${growth.length}.`,
        added: growth.length,
        removed
    }
}

export function writeInitialBaseline(root, snapshot = collectBoundarySnapshot(root)) {
    const doc = baselineDocument(
        snapshot,
        {
            r1Packages: [],
            r1Edges: [],
            r2Edges: [],
            r3Edges: [],
            r4Edges: [],
            r5Edges: [],
            r6Additions: [],
            inherited: snapshot.inheritedFiles
        },
        ''
    )
    fs.mkdirSync(path.dirname(path.join(root, BASELINE_FILE)), { recursive: true })
    fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify(doc, null, 4)}\n`)
    fs.writeFileSync(path.join(root, INHERITED_FILE), `${snapshot.inheritedFiles.join('\n')}\n`)
}

function main() {
    const argv = process.argv.slice(2)
    let update = false
    let allowNew = false
    let reason = ''
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--update') update = true
        else if (arg === '--allow-new') {
            allowNew = true
            reason = argv[i + 1] || ''
            i += 1
            if (!reason || reason.startsWith('--')) {
                console.error('Pass a reason: --allow-new "why this crossing stays".')
                process.exit(1)
            }
        } else if (arg === '--help' || arg === '-h') {
            console.log('node scripts/check-boundaries.mjs [--update] [--allow-new "reason"]')
            console.log('Checks architecture/boundaries.json. --update only shrinks architecture/boundary-baseline.json.')
            console.log('--allow-new records a new crossing and stores the reason next to that edge.')
            process.exit(0)
        } else {
            console.error(`Unknown argument ${arg}`)
            process.exit(1)
        }
    }
    if (allowNew && !update) {
        console.error('--allow-new is used together with --update.')
        process.exit(1)
    }
    if (update) {
        const result = updateBaseline(ROOT, { allowNew, reason })
        if (!result.ok) {
            console.error(result.message)
            process.exit(1)
        }
        console.log(result.message)
        const checked = checkBoundaries(ROOT)
        console.log(summaryText(checked.snapshot, checked.violations))
        writeStepSummary(checked.snapshot, checked.violations)
        process.exit(0)
    }
    const checked = checkBoundaries(ROOT)
    console.log(summaryText(checked.snapshot, checked.violations))
    writeStepSummary(checked.snapshot, checked.violations)
    if (!checked.ok) {
        printViolations(checked.violations)
        process.exit(1)
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
