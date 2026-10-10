// Root-relative source paths (E16, spec 5.8). No absolute server path leaves the server: file keys, metadata.source,
// sourceIds and every string metadata value are made relative to a known root before anything is embedded.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot, repoRoot } from '../harness/paths.mjs'
import { etlDir } from './db.mjs'
import { EtlError } from './errors.mjs'
import { splitList } from './ignore.mjs'

function toPosix(p) {
    return p.split(path.sep).join('/')
}

function under(target, root) {
    return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

// CUTTLELY_ETL_ROOTS entries, each `path` or `label=path`. The label defaults to the last path segment. Two roots with
// the same label would give the same relative keys, so that is a config problem (root_label_collision).
export function configuredRoots(env = process.env.CUTTLELY_ETL_ROOTS || '') {
    const roots = splitList(env).map((entry) => {
        const eq = entry.indexOf('=')
        const labelled = eq > 0 && !entry.slice(0, eq).includes(path.sep) && !entry.slice(0, eq).includes('/')
        const dir = path.resolve(labelled ? entry.slice(eq + 1) : entry)
        const label = (labelled ? entry.slice(0, eq) : path.basename(dir)) || 'root'
        return { path: dir, label, configured: true }
    })
    const seen = new Map()
    for (const root of roots) {
        if (seen.has(root.label) && seen.get(root.label) !== root.path) {
            throw new EtlError(
                'root_label_collision',
                `CUTTLELY_ETL_ROOTS has two roots labelled "${root.label}". Give one of them a label with the label=path form.`
            )
        }
        seen.set(root.label, root.path)
    }
    return roots
}

export function uploadsRoot() {
    return path.join(etlDir(), 'uploads')
}

function safeDirName(value) {
    const text = String(value || '').trim()
    if (!text) throw new EtlError('workspace_required', 'No active workspace. Sign in to a workspace and try again.', 400)
    const safe = text.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)
    return safe === text ? safe : `${safe}-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 8)}`
}

export const pipelineDirName = safeDirName

// One workspace's upload folder. Uploads elsewhere under uploadsRoot() belong to another workspace or predate
// workspace scoping, and no pipeline can read them.
export function workspaceUploadsRoot(workspaceId) {
    return path.join(uploadsRoot(), safeDirName(workspaceId))
}

// Refuses a Streaming Files path under the upload folder unless it is in this pipeline's workspace folder.
export function checkUploadAccess(abs, workspaceId) {
    const uploads = uploadsRoot()
    if (!under(abs, uploads)) return
    const own = workspaceId ? workspaceUploadsRoot(workspaceId) : null
    if (own && under(abs, own) && abs !== own) return
    throw uploadRefusal(abs)
}

// The refusal for an upload this pipeline can't read: another workspace's, or a flat one (`uploads/<uuid>/…`) from
// before uploads were kept per workspace. Nothing migrates flat uploads; the message says to upload the file again.
export function uploadRefusal(abs) {
    return new EtlError(
        'bad_source',
        `"${path.basename(abs)}" is an upload outside this pipeline's workspace (another workspace's, or one from before ` +
            'uploads were kept per workspace). Upload the file again from this pipeline, or copy it to a folder listed in ' +
            'CUTTLELY_ETL_ROOTS on the server and point the pipeline there.'
    )
}

export function samplesRoot() {
    return path.join(repoRoot(), 'samples', 'etl')
}

// The real path of `target`. A path that doesn't exist yet resolves its deepest existing parent, so a symlinked parent
// can't hide where it points.
export function realPath(target) {
    try {
        return fs.realpathSync.native(target)
    } catch {
        const parent = path.dirname(target)
        return parent === target ? target : path.join(realPath(parent), path.basename(target))
    }
}

export const ROOTS_HELP =
    'Set CUTTLELY_ETL_ROOTS on the server to the folders pipelines may read (comma-separated, each path or label=path) and restart it.'

// Read access for a source path (O3, spec 5.5). The path is resolved with realpath, symlinks and `..` included, and
// must be under one of these roots (also realpath-resolved):
// - CUTTLELY_ETL_ROOTS, when it is set;
// - this workspace's upload folder, etlDir()/uploads/<workspaceId>;
// - the bundled samples, <repo>/samples/etl;
// - for Code Repository only, and only while CUTTLELY_ETL_ROOTS is unset, the Cuttlely checkout (repoRoot()), never
//   under dataRoot(). Such a walk forces gitignore and the default ignores on and leaves dataRoot() out (`via: 'repo'`).
// Gives { path, real, via } (`path` stays lexical so keys don't change; `real` is what was checked), or throws bad_source.
export function pathAccess(target, { workspaceId = null, repo = false } = {}) {
    const raw = String(target || '').trim()
    if (raw.split(/[\\/]/).includes('..')) throw new EtlError('bad_path', `Path "${raw}" uses "..". Give an absolute path.`)
    if (!path.isAbsolute(raw)) throw new EtlError('bad_source', `Path "${raw}" is not absolute. Give an absolute path on the server.`)
    const resolved = path.resolve(raw)
    const real = realPath(resolved)
    const configured = configuredRoots()
    const roots = [
        ...configured.map((root) => ({ path: realPath(root.path), via: 'configured' })),
        ...(workspaceId ? [{ path: realPath(workspaceUploadsRoot(workspaceId)), via: 'uploads' }] : []),
        { path: realPath(samplesRoot()), via: 'samples' }
    ]
    if (repo && !configured.length) roots.push({ path: realPath(repoRoot()), via: 'repo' })
    const match = roots.find((root) => under(real, root.path))
    if (match && !(match.via === 'repo' && under(real, realPath(dataRoot())))) return { path: resolved, real, via: match.via }
    if (under(real, realPath(uploadsRoot()))) throw uploadRefusal(raw)
    const allowed = configured.length
        ? "CUTTLELY_ETL_ROOTS, this workspace's uploads or samples/etl"
        : `this workspace's uploads${repo ? ', samples/etl or the Cuttlely checkout (outside its data folder)' : ' or samples/etl'}`
    throw new EtlError('bad_source', `Path "${raw}" is outside the folders pipelines may read (${allowed}). ${ROOTS_HELP}`)
}

// Folders under `root` that a repo walk allowed through the checkout default must leave out: the data folder and the
// ETL folder, relative to `root` (none when they are outside it).
export function repoDataExcludes(root) {
    const realRoot = realPath(root)
    const out = []
    for (const dir of [dataRoot(), etlDir()]) {
        const real = realPath(dir)
        if (real !== realRoot && under(real, realRoot)) out.push(toPosix(path.relative(realRoot, real)))
    }
    return [...new Set(out)].flatMap((rel) => [rel, `${rel}/**`])
}

// Every root a path can be made relative to, longest first: configured roots, the upload folder, the bundled samples.
export function knownRoots(workspaceId) {
    const roots = [
        ...configuredRoots(),
        ...(workspaceId ? [{ path: workspaceUploadsRoot(workspaceId), label: 'uploads', configured: false }] : []),
        { path: uploadsRoot(), label: 'uploads', configured: false },
        { path: samplesRoot(), label: 'samples', configured: false }
    ]
    return roots.sort((a, b) => b.path.length - a.path.length)
}

// The root a Streaming Files entry is keyed against (E16 metadata only; access is pathAccess's job, and it has already
// passed). A path under a known root uses that root. Without one (an entry that passed pathAccess only through a
// symlinked root, so it isn't lexically under it), the entry's own folder is the root and its folder name the label; entries of one node with the same folder name get a short hash of the folder so their
// keys stay distinct. `root` goes into metadata unless the file is under the one configured root.
export function entryRoots(entries, { workspaceId } = {}) {
    const known = knownRoots(workspaceId)
    const configured = known.filter((root) => root.configured)
    const out = entries.map((abs) => {
        const match = known.find((root) => under(abs, root.path))
        if (match) return { ...match }
        let base = abs
        try {
            if (!fs.statSync(abs).isDirectory()) base = path.dirname(abs)
        } catch {
            base = path.dirname(abs)
        }
        return { path: base, label: path.basename(base) || 'root', configured: false, fallback: true }
    })
    const byLabel = new Map()
    for (const root of out) {
        if (!root.fallback) continue
        const paths = byLabel.get(root.label) || new Set()
        paths.add(root.path)
        byLabel.set(root.label, paths)
    }
    for (const root of out) {
        if (root.fallback && byLabel.get(root.label).size > 1)
            root.label = `${root.label}-${crypto.createHash('sha256').update(root.path).digest('hex').slice(0, 6)}`
    }
    for (const root of out) root.showLabel = !(root.configured && configured.length === 1)
    return out
}

export function relativeKey(abs, root) {
    const rel = toPosix(path.relative(root.path, abs))
    return rel || path.basename(abs)
}

const existsCache = new Map()

function firstSegmentExists(value) {
    const first = value.split('/').filter(Boolean)[0]
    if (!first) return false
    if (!existsCache.has(first)) {
        let ok = false
        try {
            ok = fs.existsSync(`/${first}`)
        } catch {
            ok = false
        }
        existsCache.set(first, ok)
    }
    return existsCache.get(first)
}

// Absolute filesystem paths look like /a/b with no whitespace and a first segment that exists on this server
// (/workspace, /home, /tmp, /etc). URLs, "/api/v1" style strings and prose are left alone.
export function looksLikeServerPath(value) {
    if (typeof value !== 'string' || value.length < 2) return false
    if (/^[A-Za-z]:[\\/]/.test(value)) return true
    if (value[0] !== '/' || value[1] === '/' || /\s/.test(value)) return false
    return firstSegmentExists(value)
}

// Prefixes a string metadata value is made relative to: the known roots, any extra roots (repo clone dirs, repo
// folders), and the ETL data directory.
export function serverPrefixes(extra = []) {
    const list = [...knownRoots().map((root) => root.path), ...extra.filter(Boolean).map((p) => path.resolve(p)), path.resolve(etlDir())]
    return [...new Set(list)].sort((a, b) => b.length - a.length)
}

// Final guard before embedding, for every source type (loaders included): string metadata that starts with a known
// prefix becomes relative to it; any other absolute filesystem path becomes its basename. Returns the counts.
export function stripServerPaths(metadata, prefixes) {
    let relativized = 0
    let redacted = 0
    for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== 'string' || !value) continue
        const native = value.replaceAll('/', path.sep)
        const prefix = prefixes.find((p) => under(native, p))
        if (prefix) {
            metadata[key] = toPosix(path.relative(prefix, native)) || path.basename(prefix)
            relativized += 1
        } else if (looksLikeServerPath(value)) {
            metadata[key] = path.basename(value.replace(/[\\/]+$/, '')) || '.'
            redacted += 1
        }
    }
    return { relativized, redacted }
}

// The key of a metadata value that still holds a server path, or null. etl:check runs this on every upsert.
export function findServerPath(metadata, prefixes = serverPrefixes()) {
    for (const [key, value] of Object.entries(metadata || {})) {
        if (typeof value !== 'string') continue
        const native = value.replaceAll('/', path.sep)
        if (prefixes.some((p) => under(native, p)) || looksLikeServerPath(value)) return key
    }
    return null
}
