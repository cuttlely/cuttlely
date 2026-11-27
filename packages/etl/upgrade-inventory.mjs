import { recoverableRuntimePath } from './migrate-runtime-files.mjs'
import { isProfilePrompt } from './migrate-profile-prompts.mjs'
import { runtimeDependencies, verifiedHostFiles } from './host-files.mjs'
import { installedSkillCatalog, matchesBundledSkill } from './bundled-skills.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataRoot, hermesHome } from '../harness/paths.mjs'
import { pipelineDirName, samplesRoot, uploadsRoot, realPath } from './paths.mjs'
import { etlDir, SCHEMA_VERSION } from './db.mjs'

function problem(message) {
    throw Object.assign(new Error(message), { status: 409 })
}

function plain(file, directory = false) {
    let stat
    try {
        stat = fs.lstatSync(file)
    } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
    }
    if (!(directory ? stat.isDirectory() : stat.isFile()))
        problem('Resolve the non-regular storage path before upgrading: ' + path.basename(file))
    return true
}

function children(dir) {
    return plain(dir, true) ? fs.readdirSync(dir, { withFileTypes: true }) : []
}

export function fileFor({ kind, name }) {
    if (kind === 'etl') return path.join(etlDir(), 'etl.sqlite')
    if (kind === 'queue') return path.join(dataRoot(), 'harness-queue.sqlite')
    if (kind === 'dash') return path.join(dataRoot(), 'dashflows.sqlite')
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) problem('Invalid storage inventory name.')
    if (kind === 'vector') return path.join(etlDir(), 'vectors', name + '.sqlite')
    if (kind === 'profile') return path.join(hermesHome(), 'profiles', name, 'sessions.sqlite')
    if (kind === 'draft' && /^[0-9a-f]{64}$/.test(name)) return path.join(dataRoot(), 'harness-draft-sessions', name, 'sessions.sqlite')
    problem('Unknown storage inventory entry.')
}

const cacheSources = new Map([
    ['schema_columns.json', 'the schema shipped with the agent runtime'],
    ['tool_discovery_cache.json', 'the installed runtime tools']
])

export function discover({
    inspectCaches = false,
    hostFiles = new Map(),
    skillCatalog = inspectCaches ? installedSkillCatalog() : {}
} = {}) {
    const items = [{ kind: 'etl' }, { kind: 'queue' }, { kind: 'dash' }]
    const local = []
    const temporary = []
    const unresolved = []
    const prompts = []
    const runtimeFiles = []
    function inspectRuntimeFile(target, name) {
        const stat = fs.lstatSync(target)
        if (!recoverableRuntimePath(name)) {
            unresolved.push(name)
        } else if (stat.isDirectory() && /(?:^|\/)cache\//.test(name)) {
            const children = fs.readdirSync(target).sort()
            if (!children.length) runtimeFiles.push({ name, bytes: 0, directory: true })
            for (const child of children) inspectRuntimeFile(path.join(target, child), name + '/' + child)
        } else if (stat.isFile()) {
            // Browser and scratch directories can contain SQLite files with extensionless names.
            const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
            try {
                const header = Buffer.alloc(16)
                fs.readSync(fd, header, 0, header.length, 0)
                if (header.toString('latin1') === 'SQLite format 3\0') unresolved.push(name)
                else runtimeFiles.push({ name, bytes: stat.size, executable: Boolean(stat.mode & 0o100) })
            } finally {
                fs.closeSync(fd)
            }
        } else unresolved.push(name)
    }
    function inspectCache(home, prefix) {
        if (!inspectCaches) return
        const seedBundled = !fs.lstatSync(path.join(home, '.no-bundled-skills'), { throwIfNoEntry: false })
        let bundled = 0
        for (const { target, name, label, regular } of runtimeDependencies(home, prefix)) {
            if (hostFiles.has(path.resolve(target))) continue
            if (regular && name === 'SOUL.md' && isProfilePrompt(label)) {
                prompts.push({ name: label, bytes: fs.lstatSync(target).size })
            } else if (
                regular &&
                ['skills/.usage.json.lock', 'memories/MEMORY.md.lock', 'memories/USER.md.lock'].includes(name) &&
                fs.statSync(target).size === 0
            ) {
                temporary.push(label + ' is recreated on the next runtime update.')
            } else if (regular && recoverableRuntimePath(label)) {
                inspectRuntimeFile(target, label)
            } else if (regular && name === 'skills/.bundled_manifest') {
                temporary.push(label + ' is recreated by skill sync. Prior sync history and remembered deletions reset.')
            } else if (regular && name === 'skills/.curator_state') {
                temporary.push(label + ' resets curator history and the pause setting on disk loss.')
            } else if (regular && seedBundled && matchesBundledSkill(target, skillCatalog?.[name])) {
                bundled++
            } else unresolved.push(label)
        }
        if (bundled) temporary.push(prefix + 'skills/ · ' + bundled + ' files match the installed bundle and can be seeded again.')
        const cache = path.join(home, 'cache')
        const stat = fs.lstatSync(cache, { throwIfNoEntry: false })
        if (!stat) return
        if (!stat.isDirectory()) {
            unresolved.push(prefix + 'cache')
            return
        }
        for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
            const location = prefix + 'cache/' + entry.name
            const source = entry.isFile() && cacheSources.get(entry.name)
            if (source) temporary.push(location + ' is rebuilt from ' + source + ' on next use.')
            else inspectRuntimeFile(path.join(cache, entry.name), location)
        }
    }
    inspectCache(hermesHome(), '')
    for (const entry of children(path.join(etlDir(), 'vectors'))) {
        const match = /^(.+)\.sqlite(?:\.migrated)?$/.exec(entry.name)
        if (!match) continue
        if (!/^[a-z0-9_-]{1,80}$/.test(match[1])) problem('Resolve the unrecognized local vector collection before upgrading.')
        if (!items.some((item) => item.kind === 'vector' && item.name === match[1])) items.push({ kind: 'vector', name: match[1] })
    }
    for (const [kind, dir] of [
        ['profile', path.join(hermesHome(), 'profiles')],
        ['draft', path.join(dataRoot(), 'harness-draft-sessions')]
    ]) {
        for (const entry of children(dir)) {
            if (entry.isSymbolicLink()) problem('Resolve the linked session directory before upgrading.')
            if (!entry.isDirectory()) continue
            const folder = path.join(dir, entry.name)
            if (kind === 'profile') inspectCache(folder, 'profiles/' + entry.name + '/')
            if (plain(path.join(folder, 'sessions.sqlite')) || plain(path.join(folder, 'sessions.sqlite.migrated')))
                items.push({ kind, name: entry.name })
            if (kind === 'profile' && plain(path.join(folder, 'state.db'))) local.push('profile/' + entry.name + '/state.db')
        }
    }
    if (plain(path.join(hermesHome(), 'state.db'))) local.push('state.db')
    const stores = items.filter((item) => plain(fileFor(item)) || plain(fileFor(item) + '.migrated'))
    const profiles = stores.filter((item) => item.kind === 'profile').map((item) => item.name.toLowerCase())
    if (new Set(profiles).size !== profiles.length) problem('Resolve case-colliding harness profiles before upgrading.')
    prompts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    runtimeFiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { stores, local, temporary, unresolved, prompts, runtimeFiles }
}

export async function etlDependencyContext(source, state, hostFiles = verifiedHostFiles(state.hostFiles)) {
    const sql = (schema) => `SELECT p.id AS flow, p.workspace_id AS workspace, 'ETL version ' || v.version AS revision, v.flow_data AS graph
        FROM ${schema}pipeline_versions v JOIN ${schema}pipelines p ON p.id=v.pipeline_id`
    let canvases = []
    if (state.phase === 'postgres') {
        canvases = await source.query(sql('cuttlely_etl.'))
    } else {
        const live = fileFor({ kind: 'etl' })
        const original = [live, live + '.migrated'].find((file) => plain(file))
        if (original) {
            const db = new DatabaseSync(original, { readOnly: true })
            try {
                if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='pipeline_versions'").get()) canvases = db.prepare(sql('')).all()
            } finally {
                db.close()
            }
        }
    }
    const sample = realPath(samplesRoot())
    return {
        canvases,
        hostFile(input) {
            return typeof input === 'string' && path.isAbsolute(input) && hostFiles.has(path.resolve(input))
        },
        etlSource(input, workspace) {
            if (path.isAbsolute(input) && hostFiles.has(path.resolve(input))) return 'host'
            if (!workspace || input.split(/[\\/]/).includes('..')) return 'external'
            const prefix = 'cuttlely-etl-upload/'
            const root = state.etlUploadRoot || path.resolve(uploadsRoot())
            const relative = input.startsWith(prefix) ? input.slice(prefix.length).split('/') : path.relative(root, input).split(path.sep)
            if (relative.length === 4 && relative[0] === pipelineDirName(workspace) && /^[a-f0-9-]{36}$/.test(relative[2])) return 'upload'
            if (path.isAbsolute(input) && realPath(input).startsWith(sample + path.sep) && fs.existsSync(input)) return 'sample'
            return 'external'
        }
    }
}

export function inspectStore(item) {
    let file = fileFor(item)
    const retired = !plain(file)
    if (retired) file += '.migrated'
    for (const suffix of ['', '-wal', '-shm', '-journal']) plain(file + suffix)
    const bytes = fs.statSync(file).size + (fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').size : 0)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
        const version = db.prepare('PRAGMA user_version').get().user_version
        if (version > (item.kind === 'etl' ? SCHEMA_VERSION : 0)) problem('Unsupported SQLite schema version for ' + item.kind)
        const counts = {}
        const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7) <> 'sqlite_' ORDER BY name").all()
        for (const { name } of names) counts[name] = db.prepare('SELECT count(*) AS n FROM "' + name.replaceAll('"', '""') + '"').get().n
        const active = []
        if (!retired) {
            const check = (label, name, condition, params = []) => {
                if (counts[name] && db.prepare('SELECT 1 FROM ' + name + ' WHERE ' + condition + ' LIMIT 1').get(...params))
                    active.push(label)
            }
            if (item.kind === 'etl') check('ETL runs', 'runs', "status IN ('running','queued','pausing','cancelling')")
            if (item.kind === 'queue') {
                check('turn locks', 'turns', 'expires_at=0 OR expires_at>?', [Date.now()])
                check('queued jobs', 'jobs', "status='queued'")
                check('running jobs', 'jobs', "status='running'")
                check('draft turns', 'try_profile_turns', '1=1')
                check('agent turns', 'agent_turns', '1=1')
            }
            if (item.kind === 'dash') check('dashboard refreshes', 'dash_flow', 'lease_until>?', [Date.now()])
        }
        return { ...item, retired, bytes, version, counts, busy: active.length > 0, active }
    } finally {
        db.close()
    }
}

export function inspectRuntime(name) {
    const file = name === 'state.db' ? path.join(hermesHome(), name) : path.join(hermesHome(), 'profiles', name.split('/')[1], 'state.db')
    let db
    try {
        db = new DatabaseSync(file, { readOnly: true })
        const counts = {}
        // User tables only. FTS backing tables are an implementation detail of the runtime search index.
        for (const row of db
            .prepare(
                "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name"
            )
            .all()) {
            counts[row.name] = db.prepare('SELECT count(*) AS n FROM "' + row.name.replaceAll('"', '""') + '"').get().n
        }
        return { name, counts }
    } catch {
        return { name, unavailable: true }
    } finally {
        db?.close()
    }
}
