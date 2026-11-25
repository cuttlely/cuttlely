// Saved rosters and staged canvas deletions share one namespace on every web and worker instance.
import fs from 'node:fs'
import path from 'node:path'
import { harnessStoreDir } from './paths.mjs'
import { harnessUsesPostgres, harnessRecordDatabase } from './side-store-postgres.mjs'
import { assertStorageReady } from './side-store-maintenance.mjs'
import { HarnessError } from './errors.mjs'

export const recordEntry = /^[A-Za-z][A-Za-z0-9_-]{0,63}\.json(?:\.deleting)?$/
function file(entry) {
    if (!recordEntry.test(entry)) throw new Error('Invalid harness record name.')
    return path.join(harnessStoreDir(), entry)
}

export function recordEntries() {
    if (harnessUsesPostgres())
        return harnessRecordDatabase()
            .prepare('SELECT entry FROM harness_records ORDER BY entry')
            .all()
            .map((r) => r.entry)
    return fs.readdirSync(harnessStoreDir())
}

export function readRecord(entry) {
    const location = file(entry)
    if (harnessUsesPostgres())
        return harnessRecordDatabase().prepare('SELECT content FROM harness_records WHERE entry=?').get(entry)?.content ?? null
    try {
        return fs.readFileSync(location, 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
    }
}

export function recordExists(entry) {
    const location = file(entry)
    if (harnessUsesPostgres()) return Boolean(harnessRecordDatabase().prepare('SELECT 1 FROM harness_records WHERE entry=?').get(entry))
    return fs.existsSync(location)
}

// Compare the bytes used for the ownership check with the live row in the same write.
export function writeRecord(entry, content, previous) {
    assertStorageReady()
    const location = file(entry)
    if (!harnessUsesPostgres()) {
        fs.mkdirSync(harnessStoreDir(), { recursive: true })
        fs.writeFileSync(location, content)
        return
    }
    const db = harnessRecordDatabase()
    db.exec('BEGIN')
    try {
        if (recordExists(entry + '.deleting')) throw new HarnessError('name_taken', 'The agent team is being deleted.', 409)
        const result =
            previous === null
                ? db.prepare('INSERT INTO harness_records(entry,content) VALUES(?,?) ON CONFLICT DO NOTHING').run(entry, content)
                : db.prepare('UPDATE harness_records SET content=? WHERE entry=? AND content=?').run(content, entry, previous)
        if (!result.changes) throw new HarnessError('name_taken', 'The agent team changed on another instance. Reload before saving.', 409)
        db.exec('COMMIT')
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

export function removeRecord(entry) {
    assertStorageReady()
    const location = file(entry)
    if (harnessUsesPostgres()) harnessRecordDatabase().prepare('DELETE FROM harness_records WHERE entry=?').run(entry)
    else fs.rmSync(location, { force: true })
}

export function stageRecord(name, expected) {
    assertStorageReady()
    const entry = name + '.json'
    const location = file(entry)
    if (!harnessUsesPostgres()) return fs.renameSync(location, location + '.deleting')
    const result = harnessRecordDatabase()
        .prepare('UPDATE harness_records SET entry=? WHERE entry=? AND content::jsonb=CAST(? AS jsonb)')
        .run(entry + '.deleting', entry, JSON.stringify(expected))
    if (!result.changes) throw new HarnessError('name_taken', 'The agent team changed on another instance. Reload before deleting.', 409)
}

export function restoreRecord(name) {
    assertStorageReady()
    const entry = name + '.json'
    const staged = entry + '.deleting'
    const location = file(entry)
    if (!harnessUsesPostgres()) {
        try {
            fs.copyFileSync(location + '.deleting', location, fs.constants.COPYFILE_EXCL)
        } catch (error) {
            if (error.code !== 'EEXIST') throw error
        }
        fs.rmSync(location + '.deleting', { force: true })
        return
    }
    const db = harnessRecordDatabase()
    db.exec('BEGIN')
    try {
        db.prepare(
            'INSERT INTO harness_records(entry,content) SELECT ?,content FROM harness_records WHERE entry=? ON CONFLICT DO NOTHING'
        ).run(entry, staged)
        db.prepare('DELETE FROM harness_records WHERE entry=?').run(staged)
        db.exec('COMMIT')
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}
