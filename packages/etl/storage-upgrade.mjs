import { dataRoot } from '../harness/paths.mjs'
import { publishedSessionScope } from '../harness/session-scope.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { configureHarnessPostgres } from '../harness/side-store-postgres.mjs'
import { harnessPgConfig, registerSideSchema } from '../harness/side-store-identity.mjs'
import { pauseStorage } from '../harness/side-store-maintenance.mjs'
import { closeQueueDb } from '../harness/lock.mjs'
import { closeSessions } from '../harness/session.mjs'
import { appDatabaseStoresOn, defaultDashFile, setDashStore } from '../harness/dashflows.mjs'
import { copyDashStoreToAppDb, initDashStore, openPostgresDashStore } from '../harness/dashflows-postgres.mjs'
import { closeDb, SCHEMA_VERSION } from './db.mjs'
import { gate, drained, useBackend } from './store.mjs'
import { scheduleBusy as etlScheduleBusy } from './schedule.mjs'
import { scheduleBusy as harnessScheduleBusy } from '../harness/schedule.mjs'
import { hasActiveRuns } from './runner.mjs'
import { LocalVectorStore } from './stores.mjs'
import { missingPrivilege, openPostgresEtlStore } from './store-postgres.mjs'
import { copyEtlSnapshot, copyHarnessSnapshot, copyVectorSnapshot, snapshotSqlite, sqliteFingerprint } from './migrate-postgres.mjs'
import { discover, fileFor, inspectStore, inspectRuntime } from './upgrade-inventory.mjs'

const control = 'cuttlely_storage.upgrade'
const lock = "hashtextextended('cuttlely-side-store-instances',516)"
const progressing = (phase) => ['copying', 'retiring', 'restoring'].includes(phase)
const refuse = (message) => {
    throw Object.assign(new Error(message), { status: 409 })
}
const sum = async (file) => {
    const hash = createHash('sha256')
    for await (const block of fs.createReadStream(file)) hash.update(block)
    return hash.digest('hex')
}
const backupsDir = () => path.join(dataRoot(), 'side-store-backups')
const backupFile = (entry) => {
    if (!/^storage-backup-[a-zA-Z0-9]+$/.test(entry.backup || '')) refuse('Missing upgrade backup reference.')
    return path.join(backupsDir(), entry.backup, 'store.sqlite')
}

export async function startStorageUpgrade({
    source,
    log = console,
    config = harnessPgConfig(),
    enabled = appDatabaseStoresOn(),
    worker = false
}) {
    const member = await source.session()
    const q = async (sql, params = []) => (await member.execute(sql, params)).rows
    let state = { phase: 'sqlite', files: [] }
    const leases = new Set()
    async function tryLease(key) {
        if (lost || leases.has(key)) return null
        leases.add(key)
        try {
            if (!(await q('SELECT pg_try_advisory_lock(hashtextextended($1,517)) AS ok', [key]))[0].ok) {
                leases.delete(key)
                return null
            }
            return async () => {
                try {
                    await q('SELECT pg_advisory_unlock(hashtextextended($1,517))', [key])
                } finally {
                    leases.delete(key)
                }
            }
        } catch (error) {
            leases.delete(key)
            throw error
        }
    }
    let working = false
    let lost = false
    function maintenance(on) {
        pauseStorage(on)
        if (on) gate.close('upgrade')
        else gate.open()
    }
    member.onLost?.(() => {
        lost = true
        maintenance(true)
    })
    function closeStores() {
        closeDb()
        closeQueueDb()
        closeSessions()
        LocalVectorStore.closeAll()
        if (!state.pilot) setDashStore(null)
    }
    async function save(next) {
        await q(`INSERT INTO ${control} (id,state) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET state=excluded.state`, [
            JSON.stringify(next)
        ])
        state = next
    }
    async function activate() {
        closeStores()
        if (state.phase === 'postgres') {
            useBackend({ ...(await openPostgresEtlStore(source)), tryLease })
            configureHarnessPostgres(config)
            setDashStore(await openPostgresDashStore(source))
            if (!state.pilot) await registerSideSchema((sql, params = []) => member.execute(sql, params), 'cuttlely_dashflows')
        } else {
            useBackend(null)
            configureHarnessPostgres(null)
            if (state.pilot) setDashStore(await openPostgresDashStore(source))
        }
    }
    async function status() {
        const { stores, local } = discover()
        const inventory = stores.map(inspectStore)
        const requiredBytes = inventory.filter((s) => !s.retired).reduce((n, s) => n + s.bytes * 2, 0)
        return {
            available: true,
            enabled,
            phase: state.phase,
            busy: working,
            requiredBytes,
            stores: inventory,
            local: local.map(inspectRuntime),
            report: state.report || {},
            upgradedAt: state.upgradedAt,
            reminder: state.phase === 'postgres' && Date.now() - Date.parse(state.upgradedAt) >= 30 * 86400000
        }
    }
    async function rolledBackDashSchema(query) {
        const [schema] = await query("SELECT to_regnamespace('cuttlely_dashflows')::oid AS oid")
        if (!schema.oid) return null
        const [table] = await query("SELECT to_regclass('cuttlely_dashflows.dash_flow_store_meta') AS present")
        const [marker] = table.present ? await query("SELECT value FROM cuttlely_dashflows.dash_flow_store_meta WHERE key='copy'") : []
        if (!marker || !JSON.parse(marker.value)?.rolledBackAt)
            refuse('An existing Dashflows schema has no verified rollback marker. Review its data before upgrading.')
        return Number(schema.oid)
    }
    async function preflight(info, capacity) {
        if (info.stores.some((s) => s.busy) || hasActiveRuns())
            refuse('Wait for active ETL runs, harness turns, queued jobs and refreshes to finish.')
        const missing = await missingPrivilege(source)
        if (missing) refuse('The application database login needs ' + missing + '.')
        if (!(await q("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS ok"))[0].ok)
            refuse('The application database login needs CREATE for side-store schemas.')
        if ((await q("SELECT to_regclass('cuttlely_etl.etl_store_meta') AS present"))[0].present) {
            const version = (await q("SELECT value FROM cuttlely_etl.etl_store_meta WHERE key='schema_version'"))[0]?.value
            if (version !== String(SCHEMA_VERSION)) refuse('Unsupported target ETL schema version.')
        }
        if (!Number.isSafeInteger(capacity) || capacity < info.requiredBytes)
            refuse('Confirm the available PostgreSQL disk space shown by the database host.')
        if (info.stores.some((item) => !item.retired)) {
            fs.mkdirSync(backupsDir(), { recursive: true, mode: 0o700 })
            if (!fs.lstatSync(backupsDir()).isDirectory()) refuse('Use a plain directory for storage backups.')
            const disk = fs.statfsSync(backupsDir())
            if (disk.bavail * disk.bsize < info.requiredBytes) refuse('Insufficient disk space in the SQLite backup directory.')
        }
        if (!state.pilot && info.stores.some((item) => item.kind === 'dash' && !item.retired)) await rolledBackDashSchema(q)
        const disks = new Map()
        for (const item of info.stores.filter((x) => !x.retired)) {
            const file = fileFor(item)
            if (fs.existsSync(file + '.migrated'))
                refuse('A retained copy already exists beside a live SQLite file. Resolve the duplicate before upgrading.')
            const device = fs.statSync(file).dev
            const stat = fs.statfsSync(path.dirname(file))
            const needed = (disks.get(device) || 0) + 2 * item.bytes
            if (stat.bavail * stat.bsize < needed) refuse('Insufficient disk space for SQLite backups and verification.')
            disks.set(device, needed)
        }
    }
    async function copy(entry) {
        const file = backupFile(entry)
        if (!fs.existsSync(file) || (await sum(file)) !== entry.sha256)
            refuse('Use the original upgrade disk with its verified backups to resume.')
        if (entry.kind === 'etl') return copyEtlSnapshot(source, file)
        if (entry.kind === 'vector') return copyVectorSnapshot(source, file, entry.name)
        if (entry.kind === 'dash') {
            // The pilot normalizes historical schema on open, so give it a writable scratch copy.
            const scratch = fs.mkdtempSync(path.join(path.dirname(file), 'dash-'))
            try {
                const local = path.join(scratch, 'dash.sqlite')
                fs.copyFileSync(file, local)
                fs.chmodSync(local, 0o600)
                const result = await copyDashStoreToAppDb(local, source, { log, waitMs: 0, keepSource: true })
                if (!['already-copied', 'copied', 'reused'].includes(result.outcome)) refuse('Dashflows did not verify its copy.')
                return result
            } finally {
                fs.rmSync(scratch, { recursive: true, force: true })
            }
        }
        return copyHarnessSnapshot(
            source,
            file,
            entry.kind === 'queue' ? 'queue' : entry.kind === 'profile' ? entry.scope : 'draft:' + entry.name
        )
    }
    async function retire(entry) {
        const live = fileFor(entry),
            archived = live + '.migrated'
        if (fs.existsSync(live)) {
            const db = new DatabaseSync(live)
            try {
                const check = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
                if (check.busy || check.log !== check.checkpointed) refuse('A SQLite reader still holds the source open.')
            } finally {
                db.close()
            }
            if (!fs.existsSync(archived)) fs.linkSync(live, archived)
            if (fs.statSync(live).ino !== fs.statSync(archived).ino) refuse('A different retained SQLite file already exists.')
            fs.unlinkSync(live)
        }
        if (!fs.existsSync(archived)) refuse('The original upgrade disk is required to finish retaining SQLite files.')
        fs.chmodSync(archived, 0o400)
        const digest = await sum(archived)
        if (entry.kind === 'profile') {
            // Team deletion may remove the entire profile directory. Keep the verified original under
            // operator control too, including when the profile and backup paths are on different devices.
            const kept = backupFile(entry) + '.migrated'
            if (!fs.existsSync(kept)) {
                const temp = kept + '.tmp'
                fs.copyFileSync(archived, temp)
                fs.chmodSync(temp, 0o400)
                fs.renameSync(temp, kept)
            }
            if ((await sum(kept)) !== digest) refuse('The retained profile transcript failed verification.')
        }
        return digest
    }

    async function checkPostgresIdle() {
        const tests = [
            ['cuttlely_etl.runs', "status IN ('queued','running','cancelling','pausing')"],
            ['cuttlely_harness_queue.turns', 'expires_at=0 OR expires_at>extract(epoch FROM clock_timestamp())*1000'],
            ['cuttlely_harness_queue.jobs', "status IN ('queued','running')"],
            ['cuttlely_harness_queue.agent_turns', 'true'],
            ['cuttlely_dashflows.dash_flow', 'lease_until>extract(epoch FROM clock_timestamp())*1000']
        ]
        for (const [table, predicate] of tests) {
            if (
                (await q('SELECT to_regclass($1) AS present', [table]))[0].present &&
                (await q('SELECT 1 FROM ' + table + ' WHERE ' + predicate + ' LIMIT 1')).length
            )
                refuse('Wait for active runs, turns and refreshes to finish.')
        }
        if (
            (
                await q(
                    "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=516 AND objsubid=2 AND granted LIMIT 1"
                )
            ).length
        )
            refuse('Wait for the active draft turn to finish.')
    }
    async function transition(action, options = {}) {
        if (working || lost) refuse('Storage is busy or its database connection needs a restart.')
        if (!enabled && action === 'upgrade') refuse('Enable CUTTLELY_APP_DATABASE_STORES on the host and restart.')
        if (action === 'rollback' && options.confirm !== 'ROLLBACK') refuse('Confirm that later PostgreSQL writes will stay in PostgreSQL.')
        working = true
        let locked = false
        const guards = new Map()
        function guard(entry) {
            const file = fileFor(entry)
            if (!fs.existsSync(file)) refuse('The original SQLite disk is required to verify the upgrade.')
            if (guards.has(file)) return guards.get(file)
            const db = new DatabaseSync(file)
            try {
                db.exec('BEGIN IMMEDIATE')
                guards.set(file, db)
                return db
            } catch (error) {
                db.close()
                throw error
            }
        }
        function unguard(file) {
            const db = guards.get(file)
            if (!db) return
            try {
                db.exec('ROLLBACK')
            } finally {
                db.close()
                guards.delete(file)
            }
        }
        try {
            locked = (await q('SELECT pg_try_advisory_lock(' + lock + ') AS ok'))[0].ok
            if (!locked)
                refuse('Stop other application instances and external workers for the storage change, then restart them afterwards.')
            if (action === 'upgrade' && state.phase === 'postgres') return status()
            if (action === 'rollback' && !['postgres', 'restoring'].includes(state.phase)) refuse('Rollback requires a completed upgrade.')
            if (action === 'upgrade' && state.phase === 'restoring') refuse('Finish the interrupted rollback first.')
            if (hasActiveRuns() || leases.size || etlScheduleBusy() || harnessScheduleBusy()) refuse('Wait for active ETL runs to finish.')
            maintenance(true)
            await drained()
            if (options.drain) await options.drain()
            if (state.phase === 'postgres' && action === 'rollback') await checkPostgresIdle()
            if (action === 'upgrade' && state.phase === 'sqlite') {
                const info = await status()
                await preflight(info, options.availableBytes)
                closeStores()
                const files = []
                for (const item of info.stores) {
                    if (item.retired || (item.kind === 'dash' && state.pilot)) continue
                    const file = fileFor(item)
                    const fingerprint = sqliteFingerprint(guard(item))
                    const backup = await snapshotSqlite(file, backupsDir())
                    files.push({
                        kind: item.kind,
                        name: item.name,
                        scope: item.kind === 'profile' ? publishedSessionScope(item.name) : undefined,
                        backup: path.basename(path.dirname(backup)),
                        fingerprint,
                        sha256: await sum(backup)
                    })
                }
                await q('CREATE SCHEMA IF NOT EXISTS cuttlely_storage')
                await q('CREATE TABLE IF NOT EXISTS cuttlely_storage.owned_schema (name TEXT PRIMARY KEY, oid OID NOT NULL UNIQUE)')
                await q(`CREATE TABLE IF NOT EXISTS ${control} (id INTEGER PRIMARY KEY CHECK(id=1), state JSONB NOT NULL)`)
                await save({ ...state, phase: 'copying', files, report: {}, dashPrepared: false })
            }
            if (state.phase === 'copying' || state.phase === 'retiring') {
                for (const entry of state.files) {
                    const file = fileFor(entry)
                    let fingerprint
                    if (state.phase === 'retiring' && !fs.existsSync(file) && fs.existsSync(file + '.migrated')) {
                        const retained = new DatabaseSync(file + '.migrated', { readOnly: true })
                        try {
                            fingerprint = sqliteFingerprint(retained)
                        } finally {
                            retained.close()
                        }
                    } else fingerprint = sqliteFingerprint(guard(entry))
                    if (fingerprint !== entry.fingerprint)
                        refuse(
                            'A source changed after its backup. Restore the matching backup or inspect the conflicting writes before resuming.'
                        )
                }
            }
            if (state.phase === 'copying' && !state.pilot && !state.dashPrepared && state.files.some((entry) => entry.kind === 'dash')) {
                // A rolled-back pilot may contain later PostgreSQL writes. Preserve that generation and copy
                // the current SQLite dashboards, which are the authoritative source for this new upgrade.
                const next = { ...state, dashPrepared: true }
                await source.transaction(async (tx) => {
                    const old = await rolledBackDashSchema((sql) => tx.query(sql))
                    if (old) await tx.query('ALTER SCHEMA cuttlely_dashflows RENAME TO cuttlely_retired_' + old)
                    await tx.query(`UPDATE ${control} SET state=$1 WHERE id=1`, [JSON.stringify(next)])
                })
                state = next
            }
            if (state.phase === 'copying') {
                const report = { keptOnDisk: discover().local }
                if (state.pilot) report.dashflowsPilot = 'Already using PostgreSQL'
                if (state.files.some((entry) => entry.kind === 'dash')) report.dashflowsQueryCache = 'Rebuilt on demand'
                for (const entry of state.files) {
                    const key = [entry.kind, entry.name].filter(Boolean).join('/')
                    report[key] = await copy(entry)
                }
                await save({ ...state, phase: 'retiring', report })
            }
            if (state.phase === 'retiring') {
                const files = []
                for (const entry of state.files) {
                    unguard(fileFor(entry))
                    files.push({ ...entry, retained: await retire(entry) })
                }
                await save({ ...state, phase: 'postgres', files, upgradedAt: new Date().toISOString() })
                log.info('Verified PostgreSQL side-store upgrade ' + JSON.stringify(state.report))
            } else if (action === 'rollback') {
                const retainedFiles = new Map()
                for (const entry of state.files) {
                    const file = fileFor(entry)
                    if (
                        entry.kind === 'profile' &&
                        (publishedSessionScope(entry.name) !== entry.scope || !fs.existsSync(path.dirname(file)))
                    )
                        refuse(
                            'The owner of a retained agent team profile has changed. Review the original transcript with the operator before restoring.'
                        )
                    let retained = file + '.migrated'
                    if (!fs.existsSync(retained) && state.phase === 'restoring' && fs.existsSync(file)) retained = file
                    if (!fs.existsSync(retained) && entry.kind === 'profile' && entry.scope !== 'profile:' + entry.name.toLowerCase())
                        retained = backupFile(entry) + '.migrated'
                    retainedFiles.set(file, retained)
                    if (!retained || !fs.existsSync(retained) || (await sum(retained)) !== entry.retained)
                        refuse('Rollback requires all original retained SQLite files, with matching checksums.')
                    if (state.phase !== 'restoring' && fs.existsSync(file))
                        refuse('A live SQLite file already exists beside a retained file.')
                }
                if (state.phase !== 'restoring') await save({ ...state, phase: 'restoring' })
                closeStores()
                for (const entry of state.files) {
                    const file = fileFor(entry)
                    if (!fs.existsSync(file)) {
                        const retained = retainedFiles.get(file)
                        if (retained === file + '.migrated') fs.renameSync(retained, file)
                        else {
                            fs.copyFileSync(retained, file + '.restoring')
                            fs.renameSync(file + '.restoring', file)
                        }
                    }
                    fs.chmodSync(file, 0o600)
                }
                // Keep PostgreSQL-only writes available for recovery, under archive schemas. Re-upgrading can copy
                // subsequent SQLite edits into fresh targets without overwriting either generation.
                const next = { ...state, phase: 'sqlite', report: {} }
                await source.transaction(async (tx) => {
                    const owned = await tx.query(
                        'SELECT s.name,s.oid,n.nspname FROM cuttlely_storage.owned_schema s LEFT JOIN pg_namespace n ON n.oid=s.oid'
                    )
                    for (const row of owned) {
                        if (!row.nspname) continue // A deleted draft has no schema left to archive.
                        if (
                            row.nspname !== row.name ||
                            !/^cuttlely_(etl|dashflows|harness_queue|vec_[0-9a-f]{48}|session_[0-9a-f]{44})$/.test(row.name)
                        )
                            refuse('An owned PostgreSQL schema changed identity. Inspect it before rollback.')
                        await tx.query('ALTER SCHEMA ' + row.name + ' RENAME TO cuttlely_retired_' + row.oid)
                    }
                    await tx.query('DELETE FROM cuttlely_storage.owned_schema')
                    await tx.query(`UPDATE ${control} SET state=$1 WHERE id=1`, [JSON.stringify(next)])
                })
                state = next
                log.info('Restored pre-upgrade SQLite side stores. Later PostgreSQL writes remain in PostgreSQL.')
            }
            try {
                await activate()
            } catch (error) {
                lost = true
                throw error
            }
            return await status()
        } finally {
            for (const file of guards.keys()) unguard(file)
            if (locked) await q('SELECT pg_advisory_unlock(' + lock + ')')
            maintenance(lost || progressing(state.phase))
            working = false
        }
    }
    try {
        if (!(await q('SELECT pg_try_advisory_lock_shared(' + lock + ') AS ok'))[0].ok)
            refuse('Another instance is upgrading storage. Retry after it finishes.')
        if ((await q('SELECT to_regclass($1) AS control', [control]))[0].control) {
            state = (await q(`SELECT state FROM ${control} WHERE id=1`))[0]?.state || state
        } else {
            const pilot = (await q("SELECT to_regclass('cuttlely_dashflows.dash_flow_store_meta') AS pilot"))[0].pilot
            state.pilot = Boolean(enabled && pilot && !fs.existsSync(defaultDashFile()))
            if (enabled && !pilot && fs.existsSync(defaultDashFile() + '.migrated'))
                refuse('Reconnect the original Dashflows pilot database or restore its retained SQLite file before upgrading.')
            // Preserve the pilot's established local rollback when its switch is off.
            if (discover().stores.some((item) => item.kind !== 'dash' && fs.existsSync(fileFor(item) + '.migrated')))
                refuse('This volume contains retained side stores from another upgrade. Reconnect its application database.')
            if (!enabled && !worker) await initDashStore({ source, enabled: false, log })
        }
        if (state.phase === 'postgres' && discover().stores.some((item) => fs.existsSync(fileFor(item)))) {
            refuse('This volume still contains live SQLite side stores. Reconnect the verified volume or use an empty data mount.')
        }
        maintenance(progressing(state.phase))
        if (!progressing(state.phase)) await activate()
        return {
            status,
            transition,
            paused: () => lost || working || progressing(state.phase),
            close: async () => {
                await q('SELECT pg_advisory_unlock_shared(' + lock + ')')
                await member.release()
            }
        }
    } catch (error) {
        await member.release(error)
        maintenance(true)
        throw error
    }
}
