// Dashflows store typed source rows, never generated prose. Like the harness queue,
// this BETA uses a local SQLite database shared by processes on the same data volume.
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from './paths.mjs'
import { reviewedAggregate } from './dashflow-source-contracts.mjs'
import { parsePinnedQueries, validPinnedQueryName } from './pinned-names.mjs'
import { compilePinned, pinnedStatementLimit, validateArgs } from './runtime/pinned-query.mjs'

export class DashFlowError extends Error {
    constructor(message, status = 400) {
        super(message)
        this.status = status
    }
}
const fail = (message, status) => {
    throw new DashFlowError(message, status)
}
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const text = (v, max = 160) => typeof v === 'string' && v.trim() && v.length <= max
const safeField = (v) => text(v) && !['__proto__', 'constructor', 'prototype'].includes(v)
export function catalog(record) {
    const items = []
    for (const specialist of record.specialists || []) {
        const bindings = [...(specialist.modules || []), ...(specialist.mcpServers || [])]
        bindings.forEach((binding, bindingIndex) => {
            if (binding.nodeName !== 'postgreSQLMCP') return
            for (const pin of parsePinnedQueries(binding.inputs?.pinnedQueries)) {
                if (!validPinnedQueryName(pin.name) || !pin.testedStamp || pin.needsRetest || pin.params?.some((p) => p.secure)) continue
                try {
                    const compiled = compilePinned(pin)
                    items.push({
                        key: `${specialist.name}:${bindingIndex}:${pin.id}`,
                        specialist: specialist.name,
                        bindingIndex,
                        name: pin.name,
                        purpose: pin.purpose || pin.description || pin.name,
                        version: pin.version,
                        hash: compiled.statementHash,
                        params: (pin.params || []).map(({ name, type, required, default: defaultValue, allowedValues, min, max }) => ({
                            name,
                            type,
                            required,
                            ...(defaultValue !== undefined ? { default: defaultValue } : {}),
                            ...(allowedValues ? { allowedValues } : {}),
                            ...(min !== undefined ? { min } : {}),
                            ...(max !== undefined ? { max } : {})
                        })),
                        columns: pin.testedColumns || [],
                        testedAt: pin.testedAt || null
                    })
                } catch {
                    /* Invalid pins cannot become dashboard sources. */
                }
            }
        })
    }
    return items
}
export function sourceFor(record, key) {
    const item = catalog(record).find((p) => p.key === key)
    if (!item) fail('This tested source is no longer available. Select and test the source again.', 409)
    const specialist = record.specialists.find((s) => s.name === item.specialist)
    const binding = [...(specialist.modules || []), ...(specialist.mcpServers || [])][item.bindingIndex]
    const pin = parsePinnedQueries(binding.inputs.pinnedQueries).find(
        (p) => p.name === item.name && `${specialist.name}:${item.bindingIndex}:${p.id}` === key
    )
    return { item, pin }
}
const safePath = (value) =>
    typeof value === 'string' && value.length <= 300 && value.split('.').every((part) => /^[A-Za-z0-9_]+$/.test(part) && safeField(part))
export function sourcePath(row, fieldPath) {
    if (!safePath(fieldPath)) fail('Use a simple source field path.')
    let value = row
    for (const part of fieldPath.split('.')) {
        if (typeof value === 'string') {
            try {
                value = JSON.parse(value)
            } catch {
                return undefined
            }
        }
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
        value = value[part]
    }
    return value
}
export function validateDefinition(value) {
    if (!object(value) || !text(value.title) || !text(value.harness) || !Array.isArray(value.cards) || value.cards.length > 12)
        fail('Choose a title, harness and up to 12 cards.')
    if (![0, 604800].includes(value.intervalSeconds)) fail('Choose on-demand or weekly refresh.')
    const ids = new Set()
    const cards = value.cards.map((c) => {
        if (
            !object(c) ||
            !text(c.id, 80) ||
            ids.has(c.id) ||
            !text(c.title) ||
            !text(c.source, 300) ||
            !text(c.scope, 500) ||
            !['metric', 'bar', 'trend', 'donut', 'table'].includes(c.kind) ||
            !object(c.params) ||
            Object.keys(c.params).length > 32 ||
            !/^[a-f0-9]{64}$/.test(c.hash || '') ||
            !Number.isFinite(c.x) ||
            !Number.isFinite(c.y) ||
            c.x < 0 ||
            c.y < 0 ||
            c.x > 5000 ||
            c.y > 5000
        )
            fail('Each card needs a tested source, scope and valid canvas position.')
        if (c.kind !== 'table' && !safeField(c.valueField)) fail('Select a numeric value field.')
        if (['bar', 'trend', 'donut'].includes(c.kind) && !safeField(c.labelField)) fail('Select a label field.')
        if (
            (c.rowsPath && !safePath(c.rowsPath)) ||
            (c.completePath && !safePath(c.completePath)) ||
            (c.selectionCountPath && !safePath(c.selectionCountPath)) ||
            (c.selectionTotalPath && !safePath(c.selectionTotalPath))
        )
            fail('Invalid source field path.')
        for (const [k, v] of Object.entries(c.params)) {
            if (
                !safeField(k) ||
                !(
                    v === null ||
                    typeof v === 'boolean' ||
                    (typeof v === 'number' && Number.isFinite(v)) ||
                    (typeof v === 'string' && v.length <= 2000)
                )
            )
                fail('Parameters must be bounded scalar values.')
        }
        if (c.columns && (!Array.isArray(c.columns) || c.columns.length > 12 || c.columns.some((field) => !safeField(field))))
            fail('Invalid table columns.')
        if (c.sort && !['source', 'value-desc', 'value-asc'].includes(c.sort)) fail('Invalid display sort.')
        ids.add(c.id)
        return {
            id: c.id,
            title: c.title.trim(),
            source: c.source,
            hash: c.hash,
            scope: c.scope.trim(),
            params: c.params,
            ...(c.rowsPath ? { rowsPath: c.rowsPath } : {}),
            ...(c.completePath ? { completePath: c.completePath } : {}),
            ...(c.selectionCountPath ? { selectionCountPath: c.selectionCountPath, selectionTotalPath: c.selectionTotalPath } : {}),
            ...(c.columns ? { columns: c.columns } : {}),
            kind: c.kind,
            ...(c.sort ? { sort: c.sort } : {}),
            valueField: c.valueField || '',
            labelField: c.labelField || '',
            x: c.x,
            y: c.y
        }
    })
    return { title: value.title.trim(), harness: value.harness, intervalSeconds: value.intervalSeconds, cards }
}
export function validateSnapshot(raw, pin, card) {
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (
        !object(result) ||
        result.error ||
        !Array.isArray(result.rows) ||
        result.truncated !== false ||
        result.cursor ||
        result.columnsChanged
    )
        fail('The source did not return complete, unchanged typed rows. Last good data was kept.', 422)
    const compiled = compilePinned(pin, card.params)
    const receipt = result.pinned
    if (
        !receipt ||
        receipt.hash !== compiled.statementHash ||
        receipt.hash !== card.hash ||
        receipt.id !== pin.id ||
        receipt.name !== pin.name ||
        receipt.version !== pin.version
    )
        fail('Source identity changed. Re-select the tested query before refreshing.', 409)
    const limit = pinnedStatementLimit(compiled.runText)
    // A one-row aggregate envelope may declare its own completeness. This is an
    // explicit source contract, not a claim that every LIMIT 1 query is complete.
    const aggregate =
        limit === 1 &&
        result.rows.length === 1 &&
        ((card.completePath && sourcePath(result.rows[0], card.completePath) === true) ||
            reviewedAggregate(pin.name, compiled.statementHash, result.rows[0], card.rowsPath))
    const selectedRows = card.rowsPath && result.rows.length === 1 ? sourcePath(result.rows[0], card.rowsPath) : null
    const selectedCount = card.selectionCountPath ? sourcePath(result.rows[0], card.selectionCountPath) : null
    const selectionTotal = card.selectionTotalPath ? sourcePath(result.rows[0], card.selectionTotalPath) : null
    const selection =
        card.kind === 'table' &&
        limit === 1 &&
        result.rows.length === 1 &&
        Array.isArray(selectedRows) &&
        Number.isInteger(selectedCount) &&
        Number.isInteger(selectionTotal) &&
        selectedCount === selectedRows.length &&
        selectionTotal >= selectedCount &&
        selectedCount <= 1000
    if (card.selectionCountPath && !selection) fail('The selected-row envelope has inconsistent counts.', 422)
    if (card.completePath && !aggregate) fail('The source did not assert a complete aggregate envelope.', 422)
    if (
        ((result.possiblyTruncated || (limit !== null && result.rows.length >= limit)) && !aggregate && !selection) ||
        result.rows.length > 1000 ||
        Buffer.byteLength(JSON.stringify(result.rows)) > 512000
    )
        fail('The result may be capped. Narrow the scope or return an aggregate.', 422)
    if (result.rows.some((row) => !object(row))) fail('Source rows must be objects.', 422)
    let rows = result.rows
    if (card.rowsPath) {
        if (!aggregate && !selection) fail('Nested rows need an explicit source completeness or selected-row contract.', 422)
        rows = sourcePath(result.rows[0], card.rowsPath)
        if (typeof rows === 'string') {
            try {
                rows = JSON.parse(rows)
            } catch {
                fail('The source row array is invalid.', 422)
            }
        }
        if (!Array.isArray(rows) || rows.length > 1000 || rows.some((row) => !object(row)))
            fail('The selected source rows must be a bounded array.', 422)
    }
    if (card.kind === 'metric' && rows.length > 1) fail('A metric needs one source row. Choose a table or aggregate at the source.', 422)
    if (card.kind !== 'table') {
        for (const row of rows) {
            const value = row[card.valueField]
            // Decimal strings retain their exact source bytes; Number is used only for chart geometry.
            if (
                value !== null &&
                !(typeof value === 'number' && Number.isFinite(value)) &&
                !(typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)))
            )
                fail('The selected value field is not numeric.', 422)
            if (card.kind === 'donut' && value !== null && Number(value) < 0) fail('Composition values cannot be negative.', 422)
            if (['bar', 'trend', 'donut'].includes(card.kind) && !Object.hasOwn(row, card.labelField))
                fail('The label field is missing.', 422)
        }
    }
    return {
        cardId: card.id,
        rows,
        ...(card.rowsPath ? { evidenceRows: result.rows } : {}),
        source: {
            harness: null,
            pin: receipt.name,
            id: receipt.id,
            version: receipt.version,
            hash: receipt.hash,
            params: Object.fromEntries(
                (pin.params || []).map((p) => [p.name, Object.hasOwn(card.params, p.name) ? card.params[p.name] : p.default ?? null])
            ),
            scope: card.scope,
            rowsPath: card.rowsPath || null,
            completenessPath: card.completePath || null,
            selection: selection ? { shown: selectedCount, total: selectionTotal } : null
        },
        fetchedAt: new Date().toISOString()
    }
}
export async function materialize(definition, record, execute) {
    const snapshots = []
    const executed = new Map()
    for (const card of definition.cards) {
        const { item, pin } = sourceFor(record, card.source)
        if (item.hash !== card.hash) fail('The pinned source changed. Re-select it before refreshing.', 409)
        validateArgs(pin, card.params)
        const cacheKey = JSON.stringify([card.source, Object.entries(card.params).sort(([a], [b]) => a.localeCompare(b))])
        if (!executed.has(cacheKey)) executed.set(cacheKey, await execute(item, card.params))
        const raw = executed.get(cacheKey)
        const snapshot = validateSnapshot(raw, pin, card)
        snapshot.source.harness = definition.harness
        snapshots.push(snapshot)
    }
    if (!snapshots.length) fail('Add a card before refreshing.')
    return { id: randomUUID(), refreshedAt: new Date().toISOString(), cards: snapshots }
}

export function openDashStore(file = path.join(dataRoot(), 'dashflows.sqlite')) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS dash_flow (
            id TEXT PRIMARY KEY, workspace TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
            definition TEXT NOT NULL, snapshot TEXT, published TEXT, error TEXT,
            next_refresh INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS dash_flow_workspace ON dash_flow(workspace);
        CREATE INDEX IF NOT EXISTS dash_flow_due ON dash_flow(next_refresh);`)
    const rowFor = (id, workspace) => {
        if (!workspace) fail('Workspace required.', 403)
        const row = db.prepare('SELECT * FROM dash_flow WHERE id=? AND workspace=?').get(id, workspace)
        if (!row) fail('Dashboard not found.', 404)
        return row
    }
    // Acquire the shared-volume writer lock before reading state used by a write.
    // These transactions contain only local SQLite work, never source queries.
    const writeTransaction = (work) => {
        db.exec('BEGIN IMMEDIATE')
        try {
            const result = work()
            db.exec('COMMIT')
            return result
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }
    const decode = (row) => ({
        id: row.id,
        revision: row.revision,
        definition: JSON.parse(row.definition),
        snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
        published: Boolean(row.published),
        error: row.error,
        nextRefresh: row.next_refresh || null,
        refreshing: row.lease_until > Date.now()
    })
    return {
        close: () => db.close(),
        list(workspace) {
            if (!workspace) fail('Workspace required.', 403)
            return db
                .prepare(
                    'SELECT id, revision, definition, published IS NOT NULL AS shared FROM dash_flow WHERE workspace=? ORDER BY rowid DESC LIMIT 100'
                )
                .all(workspace)
                .map((row) => {
                    const definition = JSON.parse(row.definition)
                    return {
                        id: row.id,
                        revision: row.revision,
                        definition: { title: definition.title, harness: definition.harness },
                        published: Boolean(row.shared)
                    }
                })
        },
        get: (id, workspace) => decode(rowFor(id, workspace)),
        published(id, workspace) {
            const row = rowFor(id, workspace)
            if (!row.published) fail('This dashboard is not published.', 404)
            return { id, ...JSON.parse(row.published) }
        },
        save(id, workspace, owner, input, revision) {
            if (!workspace || !owner) fail('Sign in to save a dashboard.', 403)
            const definition = validateDefinition(input)
            if (!id) {
                id = randomUUID()
                db.prepare('INSERT INTO dash_flow(id,workspace,owner,revision,definition) VALUES(?,?,?,1,?)').run(
                    id,
                    workspace,
                    owner,
                    JSON.stringify(definition)
                )
            } else {
                rowFor(id, workspace)
                const changed = db
                    .prepare(
                        'UPDATE dash_flow SET definition=?,owner=?,revision=revision+1,snapshot=NULL,error=NULL,next_refresh=0 WHERE id=? AND workspace=? AND revision=? AND lease_until<=?'
                    )
                    .run(JSON.stringify(definition), owner, id, workspace, revision, Date.now())
                if (!changed.changes) fail('The dashboard changed or is refreshing. Reload before saving.', 409)
            }
            return decode(rowFor(id, workspace))
        },
        publish(id, workspace, revision) {
            return writeTransaction(() => {
                const row = rowFor(id, workspace)
                if (!row.snapshot || row.revision !== revision) fail('Refresh the saved draft before publishing.', 409)
                const publication = {
                    definition: JSON.parse(row.definition),
                    snapshot: JSON.parse(row.snapshot),
                    publishedAt: new Date().toISOString()
                }
                db.prepare('UPDATE dash_flow SET published=? WHERE id=? AND workspace=?').run(JSON.stringify(publication), id, workspace)
                return publication
            })
        },
        unpublish(id, workspace) {
            rowFor(id, workspace)
            db.prepare('UPDATE dash_flow SET published=NULL WHERE id=? AND workspace=?').run(id, workspace)
        },
        claim(id, workspace) {
            return writeTransaction(() => {
                const row = rowFor(id, workspace)
                const token = randomUUID()
                // At most 12 sequential bounded queries (each <=125s). Lease outlives that bound.
                const changed = db
                    .prepare('UPDATE dash_flow SET lease=?,lease_until=? WHERE id=? AND workspace=? AND lease_until<=?')
                    .run(token, Date.now() + 1800000, id, workspace, Date.now())
                if (!changed.changes) fail('A refresh is already running.', 409)
                return { token, revision: row.revision, definition: JSON.parse(row.definition), owner: row.owner }
            })
        },
        settle(id, workspace, claim, snapshot, error) {
            const next = claim.definition.intervalSeconds === 604800 ? Date.now() + 604800 * 1000 : 0
            // Refresh updates the draft. Published snapshots change only on explicit Publish.
            db.prepare(
                'UPDATE dash_flow SET snapshot=COALESCE(?,snapshot),error=?,next_refresh=?,lease=NULL,lease_until=0 WHERE id=? AND workspace=? AND lease=? AND revision=?'
            ).run(snapshot ? JSON.stringify(snapshot) : null, error || null, next, id, workspace, claim.token, claim.revision)
            return decode(rowFor(id, workspace))
        },
        due(now = Date.now()) {
            return db
                .prepare(
                    "SELECT id,workspace,owner FROM dash_flow WHERE next_refresh>0 AND next_refresh<=? AND lease_until<=? AND json_extract(definition,'$.intervalSeconds')=604800 LIMIT 10"
                )
                .all(now, now)
        }
    }
}
let store
export function dashStore() {
    return store || (store = openDashStore())
}
