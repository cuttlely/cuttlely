// Dash Flows in the application's Postgres database (CUTTLELY_APP_DATABASE_STORES, #516).
// The server hands over a source: { dialect, query(sql, params) -> rows, transaction(fn(tx)) }.
// Tests build the same shape from a plain pg pool, so this module never imports the server.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { DashFlowError, SQLITE_DASH_SCHEMA, appDatabaseStoresOn, defaultDashFile, setDashStore, validateDefinition } from './dashflows.mjs'

export const DASH_SCHEMA = 'cuttlely_dashflows'
const S = DASH_SCHEMA
const fail = (message, status) => {
    throw new DashFlowError(message, status)
}
const NUMERIC = new Set(['revision', 'next_refresh', 'lease_until', 'started', 'expires', 'seq', 'n'])
// pg returns BIGINT as text. The store compares revisions and times as numbers, as on SQLite.
const normalize = (rows) =>
    rows.map((row) => {
        const out = { ...row }
        for (const key of Object.keys(out)) if (NUMERIC.has(key) && out[key] !== null) out[key] = Number(out[key])
        return out
    })

const PG_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS ${S}.dash_flow (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, owner TEXT NOT NULL, revision BIGINT NOT NULL,
        definition TEXT NOT NULL, snapshot TEXT, published TEXT, error TEXT,
        next_refresh BIGINT NOT NULL DEFAULT 0, lease TEXT, lease_until BIGINT NOT NULL DEFAULT 0,
        seq BIGSERIAL UNIQUE
    )`,
    `CREATE INDEX IF NOT EXISTS dash_flow_workspace ON ${S}.dash_flow(workspace)`,
    `CREATE INDEX IF NOT EXISTS dash_flow_due ON ${S}.dash_flow(next_refresh)`,
    `CREATE INDEX IF NOT EXISTS dash_flow_public_token ON ${S}.dash_flow ((published::jsonb->>'publicToken')) WHERE published IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${S}.dash_flow_query_cache (
        dashboard TEXT NOT NULL, workspace TEXT NOT NULL, cache_key TEXT NOT NULL, value TEXT NOT NULL, expires BIGINT NOT NULL,
        PRIMARY KEY(dashboard, workspace, cache_key)
    )`,
    `CREATE TABLE IF NOT EXISTS ${S}.dash_flow_public_report (slot TEXT PRIMARY KEY, token TEXT NOT NULL, run_id TEXT, started BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${S}.dash_flow_refresh_status (
        dashboard TEXT NOT NULL, workspace TEXT NOT NULL, token TEXT NOT NULL, progress TEXT NOT NULL,
        PRIMARY KEY(dashboard, workspace)
    )`,
    `CREATE TABLE IF NOT EXISTS ${S}.dash_flow_store_meta (key TEXT PRIMARY KEY, value TEXT)`
]

async function schemaExists(q) {
    const [row] = await q(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present`, [S])
    return row.present === true
}

// Creates the schema and tables under one advisory lock, so two instances starting together do not race.
async function ensureSchema(tx) {
    const q = (sql, params) => tx.query(sql, params)
    await q(`SELECT pg_advisory_xact_lock(hashtext('dashflows-schema'))`)
    if (!(await schemaExists(q))) await q(`CREATE SCHEMA ${S}`)
    for (const sql of PG_SCHEMA) await q(sql)
}

// The application database user needs CREATE on the database for a new schema, or USAGE and CREATE on an existing one.
export async function missingPrivilege(source) {
    const q = (sql, params) => source.query(sql, params)
    if (!(await schemaExists(q))) {
        const [row] = await q(`SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS ok`)
        return row.ok === true ? null : 'CREATE on the application database'
    }
    const [row] = await q(
        `SELECT has_schema_privilege(current_user, $1::text, 'USAGE') AND has_schema_privilege(current_user, $1::text, 'CREATE') AS ok`,
        [S]
    )
    return row.ok === true ? null : `USAGE and CREATE on schema ${S}`
}

export async function openPostgresDashStore(source) {
    await source.transaction(ensureSchema)
    return postgresDashStore(source)
}

function postgresDashStore(source) {
    const query = async (sql, params = []) => normalize(await source.query(sql, params))
    // Each write takes a per-dashboard advisory lock before it reads, in place of SQLite's BEGIN IMMEDIATE.
    const write = (key, work) =>
        source.transaction(async (tx) => {
            const q = async (sql, params = []) => normalize(await tx.query(sql, params))
            await q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key])
            return work(q)
        })
    const lockKey = (id, workspace) => `dashflow:${workspace}:${id}`
    const rowFor = async (q, id, workspace) => {
        if (!workspace) fail('Workspace required.', 403)
        const [row] = await q(`SELECT * FROM ${S}.dash_flow WHERE id=$1 AND workspace=$2`, [id, workspace])
        if (!row) fail('Dashboard not found.', 404)
        return row
    }
    const assertActive = async (id, workspace, claim, q = query) => {
        const [row] = await q(`SELECT lease,revision,lease_until FROM ${S}.dash_flow WHERE id=$1 AND workspace=$2`, [id, workspace])
        if (!row || row.lease !== claim.token || row.revision !== claim.revision || row.lease_until <= Date.now())
            fail('This refresh was cancelled, replaced or interrupted.', 409)
    }
    const progressFor = async (q, row) => {
        const [stored] = await q(`SELECT token,progress FROM ${S}.dash_flow_refresh_status WHERE dashboard=$1 AND workspace=$2`, [
            row.id,
            row.workspace
        ])
        if (!stored) return null
        const progress = { ...JSON.parse(stored.progress), runId: stored.token }
        return progress.status === 'running' && row.lease_until <= Date.now() ? { ...progress, status: 'interrupted' } : progress
    }
    const decode = async (q, row) => ({
        id: row.id,
        revision: row.revision,
        definition: JSON.parse(row.definition),
        snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
        published: Boolean(row.published),
        publicToken: row.published ? JSON.parse(row.published).publicToken || null : null,
        error: row.error,
        nextRefresh: row.next_refresh || null,
        refreshing: row.lease_until > Date.now(),
        refreshProgress: await progressFor(q, row)
    })
    const upsertStatus = (q, id, workspace, token, progress) =>
        q(
            `INSERT INTO ${S}.dash_flow_refresh_status(dashboard,workspace,token,progress) VALUES($1,$2,$3,$4)
            ON CONFLICT (dashboard,workspace) DO UPDATE SET token=EXCLUDED.token, progress=EXCLUDED.progress`,
            [id, workspace, token, JSON.stringify(progress)]
        )
    return {
        backend: 'postgres',
        close() {},
        async queryCache(id, workspace, claim) {
            await rowFor(query, id, workspace)
            return {
                async get(key) {
                    if (claim) await assertActive(id, workspace, claim)
                    const [row] = await query(
                        `SELECT value FROM ${S}.dash_flow_query_cache WHERE dashboard=$1 AND workspace=$2 AND cache_key=$3 AND expires>$4`,
                        [id, workspace, key, Date.now()]
                    )
                    return row ? JSON.parse(row.value) : null
                },
                put(key, value) {
                    return write(lockKey(id, workspace), async (q) => {
                        if (claim) await assertActive(id, workspace, claim, q)
                        const json = JSON.stringify(value)
                        if (Buffer.byteLength(json) > 2 * 1024 * 1024) return
                        await q(
                            `INSERT INTO ${S}.dash_flow_query_cache(dashboard,workspace,cache_key,value,expires) VALUES($1,$2,$3,$4,$5)
                            ON CONFLICT (dashboard,workspace,cache_key) DO UPDATE SET value=EXCLUDED.value, expires=EXCLUDED.expires`,
                            [id, workspace, key, json, Date.parse(value.fetchedAt) + 6 * 3600000]
                        )
                        await q(`DELETE FROM ${S}.dash_flow_query_cache WHERE expires<=$1`, [Date.now()])
                        await q(
                            `DELETE FROM ${S}.dash_flow_query_cache WHERE dashboard=$1 AND workspace=$2 AND cache_key NOT IN
                            (SELECT cache_key FROM ${S}.dash_flow_query_cache WHERE dashboard=$1 AND workspace=$2 ORDER BY expires DESC LIMIT 32)`,
                            [id, workspace]
                        )
                    })
                }
            }
        },
        async list(workspace) {
            if (!workspace) fail('Workspace required.', 403)
            const rows = await query(
                `SELECT id, revision, definition, published IS NOT NULL AS shared FROM ${S}.dash_flow WHERE workspace=$1 ORDER BY seq DESC LIMIT 100`,
                [workspace]
            )
            return rows.map((row) => {
                const definition = JSON.parse(row.definition)
                return {
                    id: row.id,
                    revision: row.revision,
                    definition: { title: definition.title, harness: definition.harness },
                    published: Boolean(row.shared)
                }
            })
        },
        get: async (id, workspace) => decode(query, await rowFor(query, id, workspace)),
        async status(id, workspace) {
            if (!workspace) fail('Workspace required.', 403)
            const [row] = await query(`SELECT id,workspace,lease_until,error FROM ${S}.dash_flow WHERE id=$1 AND workspace=$2`, [
                id,
                workspace
            ])
            if (!row) fail('Dashboard not found.', 404)
            return { id, refreshing: row.lease_until > Date.now(), refreshProgress: await progressFor(query, row), error: row.error }
        },
        async published(id, workspace) {
            const row = await rowFor(query, id, workspace)
            if (!row.published) fail('This dashboard is not published.', 404)
            return { id, ...JSON.parse(row.published) }
        },
        async publicView(token) {
            if (!/^[a-f0-9-]{36}$/.test(token || '')) fail('Public dashboard not found.', 404)
            const [row] = await query(
                `SELECT * FROM ${S}.dash_flow WHERE published IS NOT NULL AND (published::jsonb->>'publicToken')=$1 LIMIT 1`,
                [token]
            )
            if (!row) fail('Public dashboard not found.', 404)
            return { workspace: row.workspace, owner: row.owner, publication: { id: row.id, ...JSON.parse(row.published) } }
        },
        reservePublicReport(token) {
            // One lock per public token keeps the count-then-insert cap exact across instances.
            return write(`dashflow-report:${token}`, async (q) => {
                const [count] = await q(`SELECT COUNT(*) AS n FROM ${S}.dash_flow_public_report WHERE token=$1 AND started>$2`, [
                    token,
                    Date.now() - 3600000
                ])
                if (count.n >= 10) fail('This dashboard has reached its hourly report limit. Try later.', 429)
                const slot = randomUUID()
                await q(`INSERT INTO ${S}.dash_flow_public_report(slot,token,run_id,started) VALUES($1,$2,NULL,$3)`, [
                    slot,
                    token,
                    Date.now()
                ])
                return slot
            })
        },
        async attachPublicReport(slot, runId) {
            await query(`UPDATE ${S}.dash_flow_public_report SET run_id=$1 WHERE slot=$2`, [runId, slot])
        },
        async hasPublicReport(token, runId) {
            return (await query(`SELECT slot FROM ${S}.dash_flow_public_report WHERE token=$1 AND run_id=$2`, [token, runId])).length > 0
        },
        async save(id, workspace, owner, input, revision) {
            if (!workspace || !owner) fail('Sign in to save a dashboard.', 403)
            const definition = validateDefinition(input)
            const target = id || randomUUID()
            return write(lockKey(target, workspace), async (q) => {
                if (!id) {
                    await q(`INSERT INTO ${S}.dash_flow(id,workspace,owner,revision,definition) VALUES($1,$2,$3,1,$4)`, [
                        target,
                        workspace,
                        owner,
                        JSON.stringify(definition)
                    ])
                } else {
                    await rowFor(q, id, workspace)
                    const changed = await q(
                        `UPDATE ${S}.dash_flow SET definition=$1,owner=$2,revision=revision+1,snapshot=NULL,error=NULL,next_refresh=0
                        WHERE id=$3 AND workspace=$4 AND revision=$5 AND lease_until<=$6 RETURNING id`,
                        [JSON.stringify(definition), owner, id, workspace, revision ?? null, Date.now()]
                    )
                    if (!changed.length) fail('The dashboard changed or is refreshing. Reload before saving.', 409)
                    await q(
                        `DELETE FROM ${S}.dash_flow_refresh_status WHERE dashboard=$1 AND workspace=$2
                        AND EXISTS (SELECT 1 FROM ${S}.dash_flow WHERE id=$1 AND workspace=$2 AND revision=$3 AND lease IS NULL)`,
                        [id, workspace, Number(revision) + 1]
                    )
                }
                return decode(q, await rowFor(q, target, workspace))
            })
        },
        publish(id, workspace, revision, makePublic = false) {
            return write(lockKey(id, workspace), async (q) => {
                const row = await rowFor(q, id, workspace)
                if (!row.snapshot || row.revision !== revision) fail('Refresh the saved draft before publishing.', 409)
                const definition = JSON.parse(row.definition)
                const snapshot = JSON.parse(row.snapshot)
                if (
                    definition.cards.some((card) => card.source.endsWith(':pq_pipeline_window')) &&
                    (!snapshot.pipelineViews || Object.keys(snapshot.pipelineViews.views || {}).length !== 20)
                )
                    fail('Refresh once to prepare every period and region before publishing.', 409)
                const publication = {
                    definition,
                    snapshot,
                    publicToken: makePublic === true ? (row.published && JSON.parse(row.published).publicToken) || randomUUID() : null,
                    publishedAt: new Date().toISOString()
                }
                await q(`UPDATE ${S}.dash_flow SET published=$1 WHERE id=$2 AND workspace=$3`, [JSON.stringify(publication), id, workspace])
                return publication
            })
        },
        async unpublish(id, workspace) {
            await rowFor(query, id, workspace)
            await query(`UPDATE ${S}.dash_flow SET published=NULL WHERE id=$1 AND workspace=$2`, [id, workspace])
        },
        assertActive: (id, workspace, claim) => assertActive(id, workspace, claim),
        async heartbeat(id, workspace, claim) {
            const now = Date.now()
            const changed = await query(
                `UPDATE ${S}.dash_flow SET lease_until=$1 WHERE id=$2 AND workspace=$3 AND lease=$4 AND revision=$5 AND lease_until>$6 RETURNING id`,
                [now + 90000, id, workspace, claim.token, claim.revision, now]
            )
            return changed.length > 0
        },
        cancel(id, workspace, runId, status = 'cancelled') {
            return write(lockKey(id, workspace), async (q) => {
                const row = await rowFor(q, id, workspace)
                if (!runId || row.lease !== runId)
                    fail('The refresh changed or already finished. Reload its status before cancelling.', 409)
                await q(
                    `UPDATE ${S}.dash_flow SET lease=NULL,lease_until=0,next_refresh=$1,error=NULL WHERE id=$2 AND workspace=$3 AND lease=$4`,
                    [JSON.parse(row.definition).intervalSeconds === 604800 ? Date.now() + 604800000 : 0, id, workspace, runId]
                )
                const [stored] = await q(
                    `SELECT progress FROM ${S}.dash_flow_refresh_status WHERE dashboard=$1 AND workspace=$2 AND token=$3`,
                    [id, workspace, runId]
                )
                const now = new Date().toISOString()
                const progress = { ...(stored ? JSON.parse(stored.progress) : {}), status, active: [], finishedAt: now, updatedAt: now }
                await upsertStatus(q, id, workspace, runId, progress)
                return { id, refreshing: false, refreshProgress: { ...progress, runId }, error: null }
            })
        },
        async progress(id, workspace, claim, detail) {
            const progress = {
                ...detail,
                ...(claim.resumeSince ? { resumeSince: claim.resumeSince } : {}),
                status: 'running',
                startedAt: claim.startedAt,
                updatedAt: new Date().toISOString()
            }
            await query(
                `UPDATE ${S}.dash_flow_refresh_status SET progress=$1 WHERE dashboard=$2 AND workspace=$3 AND token=$4
                AND EXISTS (SELECT 1 FROM ${S}.dash_flow WHERE id=$2 AND workspace=$3 AND lease=$4 AND revision=$5)`,
                [JSON.stringify(progress), id, workspace, claim.token, claim.revision]
            )
        },
        claim(id, workspace) {
            return write(lockKey(id, workspace), async (q) => {
                const row = await rowFor(q, id, workspace)
                const [previous] = await q(`SELECT progress FROM ${S}.dash_flow_refresh_status WHERE dashboard=$1 AND workspace=$2`, [
                    id,
                    workspace
                ])
                const prior = previous ? JSON.parse(previous.progress) : null
                const resumeSince = prior && ['running', 'interrupted'].includes(prior.status) ? prior.resumeSince || prior.startedAt : null
                const token = randomUUID()
                const now = Date.now()
                // A guarded single-statement update: a second claimant re-checks lease_until after the row lock and loses.
                const changed = await q(
                    `UPDATE ${S}.dash_flow SET lease=$1,lease_until=$2 WHERE id=$3 AND workspace=$4 AND lease_until<=$5 RETURNING id`,
                    [token, now + 90000, id, workspace, now]
                )
                if (!changed.length) fail('A refresh is already running.', 409)
                const startedAt = new Date().toISOString()
                await upsertStatus(q, id, workspace, token, {
                    status: 'running',
                    ...(resumeSince ? { resumeSince } : {}),
                    phase: 'starting',
                    completed: 0,
                    total: 0,
                    active: [],
                    startedAt,
                    updatedAt: startedAt
                })
                return { token, revision: row.revision, definition: JSON.parse(row.definition), owner: row.owner, startedAt, resumeSince }
            })
        },
        settle(id, workspace, claim, snapshot, error) {
            return write(lockKey(id, workspace), async (q) => {
                const next = claim.definition.intervalSeconds === 604800 ? Date.now() + 604800 * 1000 : 0
                // Refresh updates the draft. Published snapshots change only on explicit Publish.
                const changed = await q(
                    `UPDATE ${S}.dash_flow SET snapshot=COALESCE($1::text,snapshot),error=$2::text,next_refresh=$3,lease=NULL,lease_until=0
                    WHERE id=$4 AND workspace=$5 AND lease=$6 AND revision=$7 RETURNING id`,
                    [snapshot ? JSON.stringify(snapshot) : null, error || null, next, id, workspace, claim.token, claim.revision]
                )
                if (changed.length) {
                    const [prior] = await q(
                        `SELECT progress FROM ${S}.dash_flow_refresh_status WHERE dashboard=$1 AND workspace=$2 AND token=$3`,
                        [id, workspace, claim.token]
                    )
                    if (prior) {
                        const finishedAt = new Date().toISOString()
                        const previous = JSON.parse(prior.progress)
                        const progress = {
                            ...previous,
                            failedItems: error ? (previous.failedViews?.length ? previous.failedViews : previous.active || []) : [],
                            status: error ? 'failed' : 'completed',
                            active: [],
                            finishedAt,
                            updatedAt: finishedAt
                        }
                        await q(`UPDATE ${S}.dash_flow_refresh_status SET progress=$1 WHERE dashboard=$2 AND workspace=$3 AND token=$4`, [
                            JSON.stringify(progress),
                            id,
                            workspace,
                            claim.token
                        ])
                    }
                }
                return decode(q, await rowFor(q, id, workspace))
            })
        },
        async due(now = Date.now()) {
            return query(
                `SELECT id,workspace,owner FROM ${S}.dash_flow WHERE next_refresh>0 AND next_refresh<=$1 AND lease_until<=$1
                AND (definition::jsonb->'intervalSeconds')='604800'::jsonb LIMIT 10`,
                [now]
            )
        }
    }
}

// ---- Copy and verify (boot only) ----

// Canonical rows for the verify digest: every column except seq and the lease, ordered by primary key.
const COPIED = [
    {
        table: 'dash_flow',
        key: ['id'],
        columns: ['id', 'workspace', 'owner', 'revision', 'definition', 'snapshot', 'published', 'error', 'next_refresh']
    },
    { table: 'dash_flow_refresh_status', key: ['dashboard', 'workspace'], columns: ['dashboard', 'workspace', 'token', 'progress'] },
    { table: 'dash_flow_public_report', key: ['slot'], columns: ['slot', 'token', 'run_id', 'started'] }
]
const canonical = (column, value) => (value === null || value === undefined ? null : NUMERIC.has(column) ? Number(value) : String(value))
function tableDigest({ key, columns }, rows) {
    const lines = rows
        .map((row) => ({
            sort: JSON.stringify(key.map((k) => String(row[k]))),
            line: JSON.stringify(columns.map((c) => canonical(c, row[c])))
        }))
        .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
        .map((entry) => entry.line)
    return createHash('sha256').update(lines.join('\n')).digest('hex')
}
// What a person changes: create and delete change the rows, save bumps revision, publish and unpublish change
// published. Refresh state (snapshot, error, next_refresh, refresh status, report slots) is left out. Used only to
// judge "changed" on later starts; copy verification keeps using `all` (L2 ruling, design 4.10).
const CONTENT = { key: ['id'], columns: ['id', 'workspace', 'owner', 'revision', 'definition', 'published'] }
function digestOf(tables) {
    const parts = {}
    for (const spec of COPIED) parts[spec.table] = { rows: tables[spec.table].length, digest: tableDigest(spec, tables[spec.table]) }
    const all = createHash('sha256')
        .update(COPIED.map((spec) => `${spec.table}:${parts[spec.table].rows}:${parts[spec.table].digest}`).join('\n'))
        .digest('hex')
    return { all, content: tableDigest(CONTENT, tables.dash_flow), parts }
}
const counts = (digest) => Object.fromEntries(Object.entries(digest.parts).map(([table, part]) => [table, part.rows]))

class VerifyMismatch extends Error {
    constructor(table, source, copied) {
        super('verify mismatch')
        Object.assign(this, { table, source, copied })
    }
}

const MESSAGES = {
    ignored: 'CUTTLELY_APP_DATABASE_STORES is ignored: the application database is not Postgres. Dash Flows stays on dashflows.sqlite.',
    rolledBack:
        'Dash Flows is back on dashflows.sqlite because CUTTLELY_APP_DATABASE_STORES is off. Changes made while it was on are still in the application database and were not copied back.',
    reused: 'Dash Flows is using the copy already in the application database. Changes made in dashflows.sqlite while CUTTLELY_APP_DATABASE_STORES was off were not carried forward.',
    lease: (row) =>
        `Dash Flows storage move not started: a dashboard refresh is still running after 2 minutes (dashboard ${row.id}, workspace ${row.workspace}). Nothing was copied. Dash Flows keeps using dashflows.sqlite and will try again at the next start. If another Cuttlely instance shares this data directory, stop it first.`,
    busy: 'Dash Flows storage move not started: dashflows.sqlite stayed locked by another writer for 2 minutes. Nothing was copied. Dash Flows keeps using dashflows.sqlite and will try again at the next start. If another Cuttlely instance shares this data directory, stop it first.',
    verify: (m) =>
        `Dash Flows storage move failed verification (${m.table}: ${m.source} rows in dashflows.sqlite, ${m.copied} copied). Nothing was switched; Dash Flows keeps using dashflows.sqlite.`,
    privilege: (missing) =>
        `Dash Flows storage move not started: the application database user lacks ${missing}. Nothing was copied. Dash Flows keeps using dashflows.sqlite and will try again at the next start.`,
    failed: (code) =>
        `Dash Flows storage move failed (${code}). Nothing was switched; Dash Flows keeps using dashflows.sqlite and will try again at the next start.`,
    moved: (digest) =>
        `Dash Flows is in the application database (${Object.entries(counts(digest))
            .map(([table, rows]) => `${table}: ${rows} rows`)
            .join(', ')}; digest ${digest.all.slice(
            0,
            12
        )}). Copied and verified; the query cache was not copied. dashflows.sqlite is kept read-only as dashflows.sqlite.migrated.`,
    finished:
        'Dash Flows is in the application database; its copy was already there. dashflows.sqlite is kept read-only as dashflows.sqlite.migrated.',
    unreachable: (code) =>
        `Dash Flows could not open its tables in the application database (${code}). Its requests fail until the database is reachable.`,
    kept: 'Dash Flows is in the application database. dashflows.sqlite and dashflows.sqlite.migrated both exist and were left in place; remove or rename one to finish the move.',
    stillOpen:
        'Dash Flows is in the application database, but another process is still reading dashflows.sqlite, so its WAL checkpoint did not finish. dashflows.sqlite and its WAL were left as they are and are not used; the move aside finishes at the next start.',
    notMoved: (code) =>
        `Dash Flows is in the application database, but dashflows.sqlite could not be moved aside (${code}). It was left in place and is not used; the move aside finishes at the next start.`,
    refreshOnly:
        'Dash Flows is using the copy already in the application database. dashflows.sqlite changed after the copy only through refreshes (snapshots, errors, due times, report slots); those were not carried forward, and dashboards refresh again on their schedule.',
    partlyMoved: (code) =>
        `Dash Flows is in the application database. dashflows.sqlite was moved aside as dashflows.sqlite.migrated, but the move did not finish (${code}): dashflows.sqlite.migrated may still be writable, and dashflows.sqlite-wal or dashflows.sqlite-shm may remain. Neither is used while CUTTLELY_APP_DATABASE_STORES stays on.`,
    diverged:
        'Dash Flows storage move stopped: dashflows.sqlite differs from the copy in the application database, and no switch-off was recorded. Dash Flows serves dashflows.sqlite; changes made in the application database since the copy are kept there but not shown. Decide which copy to keep before starting with CUTTLELY_APP_DATABASE_STORES on again.'
}
const errorCode = (error) =>
    String(error?.code || error?.name || 'error')
        .replace(/[^A-Za-z0-9_]/g, '')
        .slice(0, 32)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const busyError = (error) => (error?.errcode & 0xff) === 5 || /database is locked|SQLITE_BUSY/.test(String(error?.message))

async function readMarker(q) {
    const [row] = await q(`SELECT value FROM ${S}.dash_flow_store_meta WHERE key='copy'`)
    return row ? JSON.parse(row.value) : null
}
const writeMarker = (q, marker) =>
    q(`INSERT INTO ${S}.dash_flow_store_meta(key,value) VALUES('copy',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [
        JSON.stringify(marker)
    ])

function readSqlite(db) {
    return {
        dash_flow: db.prepare('SELECT * FROM dash_flow ORDER BY rowid ASC').all(),
        dash_flow_refresh_status: db.prepare('SELECT * FROM dash_flow_refresh_status').all(),
        dash_flow_public_report: db.prepare('SELECT * FROM dash_flow_public_report').all()
    }
}

// Waits up to waitMs for every refresh lease to clear, holding BEGIN IMMEDIATE so no writer on the volume
// can start one while the copy runs. Returns the open database, or a refusal.
async function preflight(file, { waitMs, pollMs }) {
    const db = new DatabaseSync(file)
    db.exec(SQLITE_DASH_SCHEMA)
    const deadline = Date.now() + waitMs
    for (;;) {
        let live = null
        let busy = false
        try {
            db.exec('BEGIN IMMEDIATE')
            live = db.prepare('SELECT id, workspace FROM dash_flow WHERE lease_until>? LIMIT 1').get(Date.now()) || null
            if (!live) return { db }
            db.exec('ROLLBACK')
        } catch (error) {
            if (!busyError(error)) {
                db.close()
                throw error
            }
            busy = true
        }
        if (Date.now() >= deadline) {
            db.close()
            return { refused: busy ? MESSAGES.busy : MESSAGES.lease(live) }
        }
        await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())))
    }
}

// Ends the SQLite transaction, checkpoints the WAL and keeps the file read-only beside the new store.
// When both files already exist, neither is touched (design 4.9 (b)). When another process still reads the
// file, the checkpoint cannot finish: the file and its WAL stay as they are, so the rollback file stays whole.
// Only a reader holding a snapshot blocks the checkpoint; an idle connection in another process does not, so the
// file can be moved while that process still has it open (pre-existing; stop other processes before switching on).
function retire(db, file) {
    db.exec('ROLLBACK')
    const migrated = `${file}.migrated`
    if (fs.existsSync(migrated)) {
        db.close()
        return 'kept'
    }
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    db.close()
    if (checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) return 'still-open'
    if (fs.existsSync(file)) fs.renameSync(file, migrated)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true })
    fs.chmodSync(migrated, 0o444)
    return 'moved'
}

// One-store copy and verify (#516). SQLite stays authoritative until the Postgres copy is verified and committed.
export async function copyDashStoreToAppDb(file, source, { log = console, waitMs = 120000, pollMs = 10000 } = {}) {
    const checked = await preflight(file, { waitMs, pollMs })
    if (checked.refused) {
        log.warn(checked.refused)
        return { outcome: 'refused-lease' }
    }
    const { db } = checked
    let result
    try {
        const tables = readSqlite(db)
        const digest = digestOf(tables)
        result = await source.transaction(async (tx) => {
            const q = async (sql, params = []) => normalize(await tx.query(sql, params))
            await ensureSchema(tx)
            await q(`SELECT pg_advisory_xact_lock(hashtext('dashflows-copy'))`)
            const marker = await readMarker(q)
            if (marker && marker.sourceDigest === digest.all && !marker.rolledBackAt) return { outcome: 'already-copied', digest }
            // Changed only through refreshes since the copy: nothing a person made is lost, so finish the move. The
            // marker is not rewritten, so a move aside that fails again reaches the same result next start.
            if (marker && marker.contentDigest && marker.contentDigest === digest.content && !marker.rolledBackAt)
                return { outcome: 'already-copied', digest, refreshOnly: true }
            // A difference with no recorded switch-off is not a rollback: refuse rather than drop either side.
            if (marker && !marker.rolledBackAt) return { outcome: 'diverged', digest }
            if (marker) {
                // Re-enable after a rollback: keep the Postgres copy (Founder decision Q2). The marker takes this
                // file's digest, so if the move aside does not finish now, the next start only finishes it. `rows`
                // and `copiedAt` still describe the first copy; `copiedDigest` keeps its fingerprint and
                // `reusedRows`/`reusedAt` describe the reused file.
                const { rolledBackAt: _rolledBackAt, ...rest } = marker
                await writeMarker(q, {
                    ...rest,
                    copiedDigest: rest.copiedDigest ?? marker.sourceDigest,
                    sourceDigest: digest.all,
                    contentDigest: digest.content,
                    reusedRows: counts(digest),
                    reusedAt: new Date().toISOString()
                })
                return { outcome: 'reused', digest }
            }
            await q(`TRUNCATE ${S}.dash_flow, ${S}.dash_flow_query_cache, ${S}.dash_flow_public_report, ${S}.dash_flow_refresh_status`)
            // rowid order, so seq keeps the list order. Leases are not live after the preflight.
            for (const row of tables.dash_flow)
                await q(
                    `INSERT INTO ${S}.dash_flow(id,workspace,owner,revision,definition,snapshot,published,error,next_refresh,lease,lease_until)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,0)`,
                    [
                        row.id,
                        row.workspace,
                        row.owner,
                        row.revision,
                        row.definition,
                        row.snapshot,
                        row.published,
                        row.error,
                        row.next_refresh
                    ]
                )
            for (const row of tables.dash_flow_refresh_status)
                await q(`INSERT INTO ${S}.dash_flow_refresh_status(dashboard,workspace,token,progress) VALUES($1,$2,$3,$4)`, [
                    row.dashboard,
                    row.workspace,
                    row.token,
                    row.progress
                ])
            for (const row of tables.dash_flow_public_report)
                await q(`INSERT INTO ${S}.dash_flow_public_report(slot,token,run_id,started) VALUES($1,$2,$3,$4)`, [
                    row.slot,
                    row.token,
                    row.run_id,
                    row.started
                ])
            const copied = digestOf({
                dash_flow: await q(`SELECT * FROM ${S}.dash_flow`),
                dash_flow_refresh_status: await q(`SELECT * FROM ${S}.dash_flow_refresh_status`),
                dash_flow_public_report: await q(`SELECT * FROM ${S}.dash_flow_public_report`)
            })
            for (const spec of COPIED) {
                const before = digest.parts[spec.table]
                const after = copied.parts[spec.table]
                if (before.rows !== after.rows || before.digest !== after.digest)
                    throw new VerifyMismatch(spec.table, before.rows, after.rows)
            }
            await writeMarker(q, {
                sourceDigest: digest.all,
                contentDigest: digest.content,
                rows: counts(digest),
                copiedAt: new Date().toISOString(),
                version: 1
            })
            return { outcome: 'copied', digest }
        })
    } catch (error) {
        try {
            db.exec('ROLLBACK')
        } catch {
            /* Already ended. */
        }
        db.close()
        if (error instanceof VerifyMismatch) {
            log.warn(MESSAGES.verify(error))
            return { outcome: 'verify-failed' }
        }
        // Error text can carry row values or connection details; log the code only.
        log.warn(MESSAGES.failed(errorCode(error)))
        return { outcome: 'failed' }
    }
    if (result.outcome === 'diverged') {
        db.exec('ROLLBACK')
        db.close()
        log.error(MESSAGES.diverged)
        return { outcome: 'diverged' }
    }
    if (result.outcome === 'reused') log.warn(MESSAGES.reused)
    if (result.refreshOnly) log.info(MESSAGES.refreshOnly)
    // The copy is committed from here on: Postgres serves even if the file cannot be moved aside.
    let retired
    try {
        retired = retire(db, file)
    } catch (error) {
        try {
            db.close()
        } catch {
            /* Already closed. */
        }
        // The failure can come after the move itself (the read-only mode or the -wal/-shm cleanup); say which.
        const partly = !fs.existsSync(file) && fs.existsSync(`${file}.migrated`)
        log.warn((partly ? MESSAGES.partlyMoved : MESSAGES.notMoved)(errorCode(error)))
        return { outcome: result.outcome, rows: counts(result.digest), retired: 'failed' }
    }
    if (retired === 'kept') log.warn(MESSAGES.kept)
    else if (retired === 'still-open') log.warn(MESSAGES.stillOpen)
    else log.info(result.outcome === 'copied' ? MESSAGES.moved(result.digest) : MESSAGES.finished)
    return { outcome: result.outcome, rows: counts(result.digest), retired }
}

// Switch off (or not Postgres) after a move: put dashflows.sqlite back as it was at the copy. No reverse copy.
async function restore(file, source, log) {
    const migrated = `${file}.migrated`
    if (!fs.existsSync(migrated) || fs.existsSync(file)) return false
    fs.renameSync(migrated, file)
    fs.chmodSync(file, 0o644)
    if (source?.dialect === 'postgres') {
        try {
            await source.transaction(async (tx) => {
                const q = (sql, params = []) => tx.query(sql, params)
                if (!(await schemaExists(q))) return
                const marker = await readMarker(q)
                if (marker) await writeMarker(q, { ...marker, rolledBackAt: new Date().toISOString() })
            })
        } catch {
            /* Best effort: the rollback does not depend on the marker. */
        }
    }
    log.warn(MESSAGES.rolledBack)
    return true
}

// Boot entry, before the server listens and before the Dash Flows scheduler starts. Picks the backend once.
export async function initDashStore({
    file = defaultDashFile(),
    source = null,
    enabled = appDatabaseStoresOn(),
    log = console,
    waitMs = 120000,
    pollMs = 10000
} = {}) {
    const onPostgres = source?.dialect === 'postgres'
    // Nothing may hold dashflows.sqlite open while it is copied or moved.
    setDashStore(null, file)
    const sqlite = (outcome) => {
        setDashStore(null, file)
        return { backend: 'sqlite', outcome }
    }
    if (enabled && !onPostgres) log.info(MESSAGES.ignored)
    if (!enabled || !onPostgres) return sqlite((await restore(file, onPostgres ? source : null, log)) ? 'rolled-back' : 'unchanged')
    let outcome = 'nothing-to-copy'
    let committed = false
    const moved = () => !fs.existsSync(file) && fs.existsSync(`${file}.migrated`)
    try {
        if (moved()) {
            // A moved file with no committed copy in this database: put the file back and copy it, as on a
            // first start (design 4.9 (a)). Reading the marker creates nothing.
            const marker = await source.transaction(async (tx) => {
                const q = (sql, params = []) => tx.query(sql, params)
                if (!(await schemaExists(q))) return null
                const [row] = await q(`SELECT to_regclass($1) IS NOT NULL AS present`, [`${S}.dash_flow_store_meta`])
                return row.present === true ? readMarker(q) : null
            })
            if (!marker) {
                fs.renameSync(`${file}.migrated`, file)
                fs.chmodSync(file, 0o644)
            }
        }
        // The privilege check runs before every copy, including the re-copy above (design 4.9 (c)). Once the
        // file is moved aside and the marker is committed, nothing is created, so it is skipped.
        const missing = moved() ? null : await missingPrivilege(source)
        if (missing) {
            log.warn(MESSAGES.privilege(missing))
            return sqlite('refused-privilege')
        }
        if (fs.existsSync(file)) {
            outcome = (await copyDashStoreToAppDb(file, source, { log, waitMs, pollMs })).outcome
            if (!['copied', 'already-copied', 'reused'].includes(outcome)) return sqlite(outcome)
            committed = true
        }
        const store = await openPostgresDashStore(source)
        setDashStore(store)
        return { backend: 'postgres', outcome }
    } catch (error) {
        if (!moved() && !committed) {
            log.warn(MESSAGES.failed(errorCode(error)))
            return sqlite('failed')
        }
        log.warn(MESSAGES.unreachable(errorCode(error)))
        // Already moved, or the copy is committed: serve Postgres, whose calls fail until it is reachable.
        setDashStore(postgresDashStore(source))
        return { backend: 'postgres', outcome: 'failed' }
    }
}
