import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataRoot, hermesHome } from '../harness/paths.mjs'
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

export function discover() {
    const items = [{ kind: 'etl' }, { kind: 'queue' }, { kind: 'dash' }]
    const local = []
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
            if (plain(path.join(folder, 'sessions.sqlite')) || plain(path.join(folder, 'sessions.sqlite.migrated')))
                items.push({ kind, name: entry.name })
            if (kind === 'profile' && plain(path.join(folder, 'state.db'))) local.push('profile/' + entry.name + '/state.db')
        }
    }
    if (plain(path.join(hermesHome(), 'state.db'))) local.push('state.db')
    const stores = items.filter((item) => plain(fileFor(item)) || plain(fileFor(item) + '.migrated'))
    const profiles = stores.filter((item) => item.kind === 'profile').map((item) => item.name.toLowerCase())
    if (new Set(profiles).size !== profiles.length) problem('Resolve case-colliding harness profiles before upgrading.')
    return { stores, local }
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
        let busy = false
        if (!retired) {
            const has = (name, condition, params = []) =>
                Object.hasOwn(counts, name) &&
                Boolean(db.prepare('SELECT 1 FROM ' + name + ' WHERE ' + condition + ' LIMIT 1').get(...params))
            if (item.kind === 'etl') busy = has('runs', "status IN ('running','queued','pausing','cancelling')")
            if (item.kind === 'queue')
                busy =
                    has('turns', 'expires_at=0 OR expires_at>?', [Date.now()]) ||
                    has('jobs', "status IN ('queued','running')") ||
                    has('try_profile_turns', '1=1') ||
                    has('agent_turns', '1=1')
            if (item.kind === 'dash') busy = has('dash_flow', 'lease_until>?', [Date.now()])
        }
        return { ...item, retired, bytes, version, counts, busy }
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
