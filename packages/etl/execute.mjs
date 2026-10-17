import crypto from 'node:crypto'
import { parseJson, stmt, tx } from './db.mjs'
import { EtlError, errorMessage } from './errors.mjs'
import { embeddingFingerprint, LOCAL_STORE, stableStringify, storeFingerprint } from './graph.mjs'
import { compareSegments } from './ignore.mjs'
import { createEmbeddings, Embedder, retrying } from './embed.mjs'
import { addEvent, DEFAULT_SETTINGS, getRun, MIN_READS_FOR_RATIO, updateRun } from './runs.mjs'
import { fault, isCrash } from './faults.mjs'
import { classifyStoreError, storeErrorStatus } from './store-errors.mjs'
import { Ledger, summaryOf } from './ledger.mjs'
import { findServerPath, serverPrefixes, stripServerPaths } from './paths.mjs'
import { finishMetadata, flattenLoaderMetadata, RecordReject } from './schema.mjs'
import { checkPath, estimateSource, normalizeKey, sourceUnits } from './sources.mjs'
import { legacyDeleteFirst } from './store-adapter.mjs'
import { openStore, storeScope } from './stores.mjs'
import { clipText, isWellFormed, repairUnicode } from './text.mjs'
import { compileTransforms, createSplitter, fillKeyTemplate, keyTemplateOf, splitDoc } from './transform.mjs'
import { getPipeline, getVersion, setServedVersion } from './versions.mjs'

// Metadata that only says where a chunk sits; leaving it out of the id means moved content is not re-embedded.
const POSITIONAL = new Set(['row', 'line', 'segment', 'loc', 'chunk', 'chunkIndex', 'ordinal', 'offset'])
const SWEEP_BATCH = 500
const PERSIST_MS = 1000
const RATE_WINDOW_MS = 10000
// Store-count check (E9a). Remote counts are eventually consistent, so a mismatch has to last this long.
const COUNT_SETTLE_MS = 30000
const COUNT_POLL_MS = 5000
// Above this many records, missing ids are not looked up one by one; every source is flagged instead.
const COUNT_FETCH_CAP = 100000
const STORE_COUNT_MARK = 'e9a'
// Written instead of the mark when the store could not be verified either way: the next run verifies at its start.
const STORE_COUNT_VERIFY = 'verify'
// Rejected-record events per run; past this, one line says how many more there were (E11/E12 add the rejects table).
const REJECT_EVENTS = 200
// Store statuses that name a payload problem with the request, so the batch is bisected to the bad record (E17).

function uuidFromHex(hex) {
    const h = hex.slice(0, 32).split('')
    h[12] = '5'
    h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
    const s = h.join('')
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

// The record key and the chunk's index within its record are part of the id (E8), so two identical chunks of one
// record, or of two records, never collapse into one vector.
export function chunkId(pipelineId, sourceId, docKey, text, metadata, embedFp, chunkIndex = null) {
    const stable = {}
    for (const key of Object.keys(metadata || {}).sort()) if (!POSITIONAL.has(key)) stable[key] = metadata[key]
    const index = chunkIndex === null || chunkIndex === undefined ? '' : `${chunkIndex}\0`
    const hash = crypto
        .createHash('sha256')
        .update(`${pipelineId}\0${sourceId}\0${docKey}\0${embedFp}\0${stableStringify(stable)}\0${index}`)
        .update(text)
        .digest('hex')
    return uuidFromHex(hash)
}

function yieldToLoop() {
    return new Promise((resolve) => setImmediate(resolve))
}

function inList(n) {
    return Array.from({ length: n }, () => '?').join(', ')
}

class RunState {
    constructor(run) {
        this.run = run
        this.counters = run.counters
        this.steps = run.steps
        this.checkpoint = run.checkpoint
        this.samples = []
        this.ledger = new Ledger(run.counters.ledger)
        this.storeRejectedSources = new Set()
        this.rejectEvents = 0
        this.lastPersist = 0
        this.live = { chunksPerSecond: 0, bytesPerSecond: 0, etaSeconds: null }
    }

    step(name, fields) {
        this.steps[name] = { ...this.steps[name], ...fields }
    }

    event(level, step, message) {
        addEvent(this.run.id, level, step, message)
    }

    sample() {
        const t = Date.now()
        this.samples.push({
            t,
            chunks: this.counters.embedded + this.counters.skipped,
            bytes: this.counters.bytesRead,
            units: this.counters.unitsDone
        })
        while (this.samples.length > 2 && t - this.samples[0].t > RATE_WINDOW_MS) this.samples.shift()
        const first = this.samples[0]
        const dt = (t - first.t) / 1000
        if (dt <= 0.2) return
        const last = this.samples[this.samples.length - 1]
        this.live.chunksPerSecond = Math.round((last.chunks - first.chunks) / dt)
        this.live.bytesPerSecond = Math.round((last.bytes - first.bytes) / dt)
        const unitRate = (last.units - first.units) / dt
        const { bytesTotal, bytesRead, unitsTotal, unitsDone } = this.counters
        if (bytesTotal > 0 && this.live.bytesPerSecond > 0)
            this.live.etaSeconds = Math.max(0, Math.round((bytesTotal - bytesRead) / this.live.bytesPerSecond))
        else if (unitsTotal > 0 && unitRate > 0) this.live.etaSeconds = Math.max(0, Math.round((unitsTotal - unitsDone) / unitRate))
        else this.live.etaSeconds = null
    }

    coerce(name, n = 1) {
        if (!n) return
        const coercions = (this.counters.coercions ||= {})
        coercions[name] = (coercions[name] || 0) + n
    }

    summary() {
        return summaryOf(this.ledger, {
            staleKept: this.counters.staleKept || 0,
            possibleDuplicates: Boolean(this.counters.possibleDuplicates)
        })
    }

    persist(force = false) {
        const t = Date.now()
        if (!force && t - this.lastPersist < PERSIST_MS) return
        this.lastPersist = t
        this.sample()
        this.counters.live = this.live
        this.counters.ledger = this.ledger.toJSON()
        const totals = this.ledger.totals()
        this.counters.rejected = totals.rejected.total
        this.counters.filtered = totals.filtered.total
        updateRun(this.run.id, { checkpoint: this.checkpoint, counters: this.counters, steps: this.steps })
    }
}

function lookupExisting(pipelineId, ids) {
    if (!ids.length) return new Set()
    const rows = stmt(`SELECT chunk_id FROM records WHERE pipeline_id = ? AND chunk_id IN (${inList(ids.length)})`).all(pipelineId, ...ids)
    return new Set(rows.map((row) => row.chunk_id))
}

function markSeen(pipelineId, runId, ids) {
    if (!ids.length) return
    stmt(`UPDATE records SET seen_run = ? WHERE pipeline_id = ? AND chunk_id IN (${inList(ids.length)})`).run(runId, pipelineId, ...ids)
}

function markSourceSeen(pipelineId, runId, sourceId) {
    tx(() => {
        stmt('UPDATE records SET seen_run = ? WHERE pipeline_id = ? AND source_id = ?').run(runId, pipelineId, sourceId)
        stmt('UPDATE sources SET seen_run = ? WHERE pipeline_id = ? AND source_id = ?').run(runId, pipelineId, sourceId)
    })
}

function insertRecords(pipelineId, runId, chunks) {
    const insert = stmt(
        'INSERT INTO records (pipeline_id, chunk_id, source_id, seen_run, doc_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pipeline_id, chunk_id) DO UPDATE SET source_id = excluded.source_id, seen_run = excluded.seen_run, doc_key = excluded.doc_key'
    )
    tx(() => {
        for (const chunk of chunks) insert.run(pipelineId, chunk.id, chunk.sourceId, runId, chunk.docKey || null)
    })
}

// O6, keep last good: a rejected record's key keeps the vectors its previous version wrote, so the sweep leaves them.
// Returns whether anything was kept. Not in full mode, which rebuilds from what this run accepted.
function keepLastGood(pipelineId, runId, sourceId, docKey) {
    const result = stmt(
        'UPDATE records SET seen_run = ? WHERE pipeline_id = ? AND source_id = ? AND doc_key = ? AND (seen_run IS NULL OR seen_run != ?)'
    ).run(runId, pipelineId, sourceId, docKey, runId)
    return Number(result.changes) > 0
}

// Keys already written for these units (unchanged units this run skipped, or units committed before a resume), so a
// duplicate key in a later unit is still caught.
function recordedKeys(pipelineId, sourceIds, runId = null) {
    const keys = []
    for (let i = 0; i < sourceIds.length; i += SWEEP_BATCH) {
        const slice = sourceIds.slice(i, i + SWEEP_BATCH)
        const rows = stmt(
            `SELECT DISTINCT doc_key FROM records WHERE pipeline_id = ? AND doc_key IS NOT NULL AND source_id IN (${inList(slice.length)})${
                runId ? ' AND seen_run = ?' : ''
            }`
        ).all(pipelineId, ...slice, ...(runId ? [runId] : []))
        for (const row of rows) keys.push(row.doc_key)
    }
    return keys
}

// The store preflight (describe_index_stats on Pinecone). It sends no records, so a record-class error there (Pinecone
// 4.0.0 throws PineconeBadRequestError for a 403 too) can only be configuration: every error but a transient or
// rate-limit one fails the run as store_config. Transient and rate-limit errors keep the usual retries.
async function preflightStore(store, { settings, control }) {
    try {
        await retrying(() => store.preflight(), {
            maxRetries: settings.maxRetries,
            signal: control.abort?.signal,
            classify: classifyStoreError
        })
    } catch (error) {
        const kind = classifyStoreError(error)
        if (error?.etlError || kind === 'transient' || kind === 'rate_limit') throw error
        throw storeConfigError(error, 'the preflight check (describeIndexStats)')
    }
}

// A store error classed `config` (credential, index, namespace): the run fails now with what to check, unretried.
function storeConfigError(error, action = 'the write') {
    const status = storeErrorStatus(error)
    const what = [error?.name && error.name !== 'Error' ? error.name : null, status ? `HTTP ${status}` : null].filter(Boolean).join(', ')
    return new EtlError(
        'store_config',
        `store_config: the vector store refused ${action}${what ? ` (${what})` : ''}: ${errorMessage(
            error
        )} Check the store node's credential, index and namespace, then run again.`
    )
}

// `partial` (spec 5.3.3): the run read to the end with the ledger balanced, but rejected records, failed units or
// possible duplicates. Callers have already passed the ledger check and the reject-ratio gate.
function isPartial(state) {
    const t = state.ledger.totals()
    return t.rejected.total > 0 || state.counters.unitsFailed > 0 || Boolean(state.counters.possibleDuplicates)
}

// The O9 gate: a message when more than maxRejectRatio of the records were rejected after at least 100 reads, else null.
export function rejectRatioGate(ledger, settings = {}) {
    const t = ledger.totals()
    const limit = Number.isFinite(settings.maxRejectRatio) ? settings.maxRejectRatio : DEFAULT_SETTINGS.maxRejectRatio
    if (t.read < MIN_READS_FOR_RATIO || t.rejected.total / t.read <= limit) return null
    const pct = (n) => `${Math.round(n * 1000) / 10}%`
    return `reject_ratio_exceeded: ${t.rejected.total} of ${t.read} records were rejected (${pct(t.rejected.total / t.read)}, limit ${pct(
        limit
    )}). Nothing was deleted and the served version is unchanged; fix the source data and run again.`
}

// Marks records without a doc_key that this run did not see as seen, so the sweep keeps them. Returns how many.
function keepLegacyRecords(pipelineId, runId) {
    const result = stmt(
        'UPDATE records SET seen_run = ? WHERE pipeline_id = ? AND doc_key IS NULL AND (seen_run IS NULL OR seen_run != ?)'
    ).run(runId, pipelineId, runId)
    return Number(result.changes) || 0
}

function saveSource(pipelineId, runId, marker) {
    stmt(
        'INSERT INTO sources (pipeline_id, source_id, fingerprint, seen_run, chunks) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pipeline_id, source_id) DO UPDATE SET fingerprint = excluded.fingerprint, seen_run = excluded.seen_run, chunks = excluded.chunks'
    ).run(pipelineId, marker.sourceId, marker.fingerprint, runId, marker.chunks)
}

// A store write failed for these chunks. A source whose saved fingerprint already matches what was read
// would look unchanged next run, so that fingerprint is cleared. A changed source keeps its previous one,
// which already makes the next run re-read it. Returns the source ids.
function flagFailedSources(pipelineId, chunks) {
    const sources = new Map()
    for (const chunk of chunks) sources.set(chunk.sourceId, chunk.fingerprint || null)
    const clear = stmt('UPDATE sources SET fingerprint = NULL WHERE pipeline_id = ? AND source_id = ? AND fingerprint = ?')
    tx(() => {
        for (const [sourceId, fingerprint] of sources) if (fingerprint) clear.run(pipelineId, sourceId, fingerprint)
    })
    return [...sources.keys()]
}

function recordCount(pipelineId) {
    return Number(stmt('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ?').get(pipelineId).n)
}

// Another pipeline whose latest or served version writes to the same namespace or collection.
function sharesScope(pipelineId, key) {
    const rows = stmt(
        `SELECT p.id, p.name, v.spec FROM pipelines p JOIN pipeline_versions v ON v.pipeline_id = p.id
         WHERE p.id != ? AND (v.version = p.served_version OR v.version = (SELECT MAX(version) FROM pipeline_versions WHERE pipeline_id = p.id))`
    ).all(pipelineId)
    return rows.some((row) => storeScope(parseJson(row.spec, null)?.store, row.name)?.key === key)
}

// A store client error can quote the whole request URL, which for fetch-by-id lists every chunk id. Count and
// fetch messages drop the query string and stay short.
function storeError(error) {
    return clipText(errorMessage(error).replace(/\?[^\s]*/g, ''), 301)
}

// A count or fetch call to the store is retried once before its result is classified. Gives { value }, or
// { error } when both tries fail; the caller then records the count as not verified instead of failing the run.
async function storeCall(state, what, fn) {
    try {
        return { value: await fn() }
    } catch (first) {
        state.event('warn', 'store', `The store ${what} call failed (${storeError(first)}); retrying once.`)
        try {
            return { value: await fn() }
        } catch (error) {
            return { error }
        }
    }
}

// Recorded chunk ids that fetch-by-id does not return, as { value } or { error }. value is null when they
// cannot be looked up one by one (no fetch API, or more than COUNT_FETCH_CAP records; E9b replaces that
// fallback, which flags every source, with a sampled fetch).
async function findMissing(pipelineId, store, state) {
    if (!store.missing || recordCount(pipelineId) > COUNT_FETCH_CAP) return { value: null }
    const ids = stmt('SELECT chunk_id FROM records WHERE pipeline_id = ?')
        .all(pipelineId)
        .map((row) => row.chunk_id)
    return storeCall(state, 'fetch', () => store.missing(ids))
}

// Sources whose vectors are missing from the store: drop the missing chunk ids from records (and the
// adapter's id map), clear the source fingerprint, and the next run re-embeds only what is missing.
// Without a per-id answer (missing is null), every source of the pipeline is flagged.
function flagMissing(pipelineId, store, missing) {
    const sourceIds = new Set()
    if (missing) {
        for (let i = 0; i < missing.length; i += SWEEP_BATCH) {
            const slice = missing.slice(i, i + SWEEP_BATCH)
            for (const row of stmt(
                `SELECT DISTINCT source_id FROM records WHERE pipeline_id = ? AND chunk_id IN (${inList(slice.length)})`
            ).all(pipelineId, ...slice))
                sourceIds.add(row.source_id)
        }
    } else for (const row of stmt('SELECT source_id FROM sources WHERE pipeline_id = ?').all(pipelineId)) sourceIds.add(row.source_id)
    tx(() => {
        if (missing) {
            for (let i = 0; i < missing.length; i += SWEEP_BATCH) {
                const slice = missing.slice(i, i + SWEEP_BATCH)
                stmt(`DELETE FROM records WHERE pipeline_id = ? AND chunk_id IN (${inList(slice.length)})`).run(pipelineId, ...slice)
            }
        } else
            for (const sourceId of sourceIds) stmt('DELETE FROM records WHERE pipeline_id = ? AND source_id = ?').run(pipelineId, sourceId)
        for (const sourceId of sourceIds)
            stmt('UPDATE sources SET fingerprint = NULL WHERE pipeline_id = ? AND source_id = ?').run(pipelineId, sourceId)
    })
    if (missing) store.forget(missing)
    return { missing: missing ? missing.length : null, sourceIds: [...sourceIds].sort() }
}

// Compares the pipeline's records with the store's own count for the pipeline's namespace. Runs before the
// sweep, so nothing is deleted until the store is verified. Polls while the counts differ, up to the settle
// window. Stale ids parked by a failed delete may or may not still be there. Fail closed:
// evidence of a shortfall that cannot be cleared fails the run.
// - count matches: verified. Count above the records: store_count_excess, a warning (orphans are E9b).
// - count short: fetch-by-id decides. 0 missing: store_count_lagging, a warning. Ids missing (or more than
//   COUNT_FETCH_CAP records, so no per-id answer): store_count_mismatch, the sources are flagged and the run
//   fails. Fetch failing twice: store_count_unverified, the run fails and nothing is marked synced.
// - count failing twice: fetch-by-id decides alone. If it cannot answer either (no evidence either way), the run
//   completes with store_unverified and the next run verifies at its start (the pre-E9a heal path).
// Every count or fetch call is retried once first.
async function checkStoreCount({ pipeline, spec, store, state, ctx }) {
    const scope = storeScope(spec.store, pipeline.name)
    let reason = null
    if (!store.canCount || !scope) reason = 'the store has no count API'
    else if (!scope.key) reason = scope.reason
    else if (sharesScope(pipeline.id, scope.key)) reason = 'the namespace is shared with another pipeline'
    if (reason) {
        state.counters.storeCount = { status: 'not verified', reason }
        return { verified: false }
    }
    const settle = ctx.storeCountSettle || {}
    const windowMs = settle.windowMs ?? COUNT_SETTLE_MS
    const pollMs = settle.pollMs ?? COUNT_POLL_MS
    const now = settle.now || Date.now
    const sleep = settle.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const deadline = now() + windowMs
    let records
    let stale
    let actual = null
    let countError = null
    let polls = 0
    for (;;) {
        records = recordCount(pipeline.id)
        stale = store.staleCount()
        const answer = await storeCall(state, 'count', () => store.count())
        polls += 1
        if (answer.error) {
            countError = answer.error
            break
        }
        actual = Number(answer.value)
        if ((actual >= records && actual <= records + stale) || now() >= deadline) break
        await sleep(pollMs)
    }
    const count = { store: actual, records, polls, ...(stale ? { staleKept: stale } : {}) }
    if (countError) {
        const failed = `the count call failed twice (${storeError(countError)})`
        const fetched = await findMissing(pipeline.id, store, state)
        if (fetched.value?.length === 0) {
            state.counters.storeCount = { status: 'verified', by: 'fetch', ...count, countError: failed }
            return { verified: true }
        }
        if (fetched.value?.length) {
            const flagged = flagMissing(pipeline.id, store, fetched.value)
            state.counters.storeCount = { status: 'mismatch', ...count, sourceIds: flagged.sourceIds }
            return { verified: true, mismatch: { store: null, records, ...flagged } }
        }
        const fetchWhy = fetched.error
            ? `the fetch call failed twice (${storeError(fetched.error)})`
            : 'ids cannot be fetched one by one for this pipeline'
        state.counters.storeCount = { status: 'not verified', reason: `${failed}; ${fetchWhy}`, ...count, verifyNext: true }
        return {
            verified: false,
            verifyNext: true,
            warning: `store_unverified: ${failed} and ${fetchWhy}, so there is no evidence either way about the ${records} recorded vectors. The run is served, and the next run verifies the store at its start.`
        }
    }
    if (actual >= records && actual <= records + stale) {
        state.counters.storeCount = { status: 'verified', ...count }
        return { verified: true }
    }
    if (actual > records + stale) {
        state.counters.storeCount = { status: 'excess', ...count }
        return {
            verified: true,
            warning: `store_count_excess: the store holds ${actual} vectors for this pipeline's namespace but ETL records list ${records}; ${
                actual - records - stale
            } extra vectors are not ETL's (orphans or another writer). Nothing is missing, so the run is served.`
        }
    }
    const fetched = await findMissing(pipeline.id, store, state)
    if (fetched.error) {
        state.counters.storeCount = {
            status: 'unverified',
            ...count,
            reason: `the fetch call failed twice (${storeError(fetched.error)})`
        }
        return { verified: false, unverified: { store: actual, records, error: fetched.error } }
    }
    const missing = fetched.value
    if (missing && missing.length === 0) {
        state.counters.storeCount = { status: 'lagging', ...count, missing: 0 }
        return {
            verified: true,
            warning: `store_count_lagging: the store holds ${actual} vectors for this pipeline's namespace by its count but ETL records list ${records}; fetch-by-id finds all ${records} recorded chunk ids after ${polls} polls, so the count is still catching up and the run is served.`
        }
    }
    const flagged = flagMissing(pipeline.id, store, missing)
    state.counters.storeCount = { status: 'mismatch', ...count, sourceIds: flagged.sourceIds }
    return { verified: true, mismatch: { store: actual, records, ...flagged } }
}

function mismatchText({ store, records, missing, sourceIds }) {
    const what =
        missing == null
            ? 'missing ids could not be looked up one by one, so every source is re-read'
            : `${missing} recorded chunk ids are missing from the store`
    const sources = sourceIds.length ? `; sources flagged for the next run: ${sourceIds.join(', ')}` : ''
    const held = store == null ? 'the store count could not be read' : `the store holds ${store} vectors for this pipeline's namespace`
    return `store_count_mismatch: ${held} but ETL records list ${records}; ${what}${sources}.`
}

function unverifiedText({ store, records, error }) {
    return `store_count_unverified: the store holds ${store} vectors for this pipeline's namespace but ETL records list ${records}, and fetch-by-id failed twice (${storeError(
        error
    )}), so the shortfall could not be checked. Previous fingerprints are kept, no stale vectors were deleted, and the served version is unchanged.`
}

// A run that fails store_count_unverified marks nothing synced: every source this run saved gets back the
// fingerprint it had when the run started (none for a new source), so the next run re-reads it.
function restoreFingerprints(pipelineId, runId, before) {
    const rows = stmt('SELECT source_id, fingerprint FROM sources WHERE pipeline_id = ? AND seen_run = ?').all(pipelineId, runId)
    const set = stmt('UPDATE sources SET fingerprint = ? WHERE pipeline_id = ? AND source_id = ?')
    tx(() => {
        for (const row of rows) {
            const previous = before.has(row.source_id) ? before.get(row.source_id) : null
            if (previous !== row.fingerprint) set.run(previous, pipelineId, row.source_id)
        }
    })
}

function unchangedSource(pipelineId, sourceId, fingerprint) {
    if (!fingerprint) return false
    const row = stmt('SELECT fingerprint FROM sources WHERE pipeline_id = ? AND source_id = ?').get(pipelineId, sourceId)
    return Boolean(row && row.fingerprint === fingerprint)
}

// Streams every chunk of every source in a fixed order. Resuming skips everything at or before the checkpoint;
// replaying a little before it is harmless because committed chunks are found in `records` and skipped.
//
// Every record a unit reads gets exactly one ledger entry (E7), carried on the record's last item so it is applied
// when that item's batch commits: a chunk-bearing record on its last chunk, a rejected or filtered one on a `record`
// marker. A record-final item's position points past the record, so a resume never reads it twice.
async function* produce({ spec, pipeline, run, state, ctx, embedFp, control }) {
    const checkpoint = state.checkpoint
    const full = run.mode === 'full'
    for (let si = 0; si < spec.sources.length; si += 1) {
        if (checkpoint && si < checkpoint.sourceIndex) continue
        const source = spec.sources[si]
        const nodeId = source.nodeId
        const transform = compileTransforms(source.transforms)
        const keyTemplate = keyTemplateOf(source.transforms)
        const splitter = await createSplitter(source.splitter, ctx)
        const repoRoot = source.inputs?.repoPath
            ? checkPath(source.inputs.repoPath, { workspaceId: pipeline.workspaceId, repo: true })
            : null
        const prefixes = serverPrefixes(repoRoot ? [repoRoot] : [])
        // Keys seen by this node in this run: the first record with a key wins, later ones are duplicate_key.
        const seenKeys = new Set()
        let pendingSeed = []
        if (checkpoint && si === checkpoint.sourceIndex) {
            const ids = stmt('SELECT DISTINCT source_id FROM records WHERE pipeline_id = ? AND seen_run = ? AND source_id LIKE ?')
                .all(pipeline.id, run.id, `${nodeId}:%`)
                .map((row) => row.source_id)
            for (const key of recordedKeys(pipeline.id, ids, run.id)) seenKeys.add(key)
        }
        const seedKeys = () => {
            if (!pendingSeed.length) return
            for (const key of recordedKeys(pipeline.id, pendingSeed)) seenKeys.add(key)
            pendingSeed = []
        }
        state.step('load', { status: 'running' })
        for await (const unit of sourceUnits(source, { ...ctx, pipelineId: pipeline.id, workspaceId: pipeline.workspaceId })) {
            if (control.stopRequested) return
            let resumeAt = null
            if (checkpoint && si === checkpoint.sourceIndex) {
                const order = compareSegments(unit.key, checkpoint.unitKey)
                if (order < 0 || (order === 0 && checkpoint.done)) continue
                if (order === 0) resumeAt = { offset: checkpoint.offset || 0, ordinal: checkpoint.ordinal || 0 }
            }
            const done = { type: 'marker', position: { sourceIndex: si, unitKey: unit.key, done: true } }
            if (unit.skip) {
                yield { ...done, kind: 'ignored', bytes: unit.bytes }
                continue
            }
            if (!resumeAt && !full && unchangedSource(pipeline.id, unit.sourceId, unit.fingerprint)) {
                markSourceSeen(pipeline.id, run.id, unit.sourceId)
                pendingSeed.push(unit.sourceId)
                yield { ...done, kind: 'skipped', bytes: unit.bytes }
                continue
            }
            let chunks = 0
            let bytes = 0
            try {
                for await (const doc of unit.docs(resumeAt || {})) {
                    if (control.stopRequested) return
                    const ordinal = doc.ordinal || 1
                    if (resumeAt && ordinal <= resumeAt.ordinal) continue
                    const docBytes = Math.max(0, (doc.next || 0) - (doc.offset || 0))
                    bytes += docBytes
                    const replay = { sourceIndex: si, unitKey: unit.key, offset: doc.offset || 0, ordinal: ordinal - 1, done: false }
                    const settled = { sourceIndex: si, unitKey: unit.key, offset: doc.next || 0, ordinal, done: false }
                    if (doc.bom) state.coerce('bomStripped')
                    for (const [name, n] of Object.entries(doc.coercions || {})) state.coerce(name, n)
                    const record = { nodeId, sourceId: unit.sourceId, unitKey: unit.key, ordinal, key: doc.docKey || null, chunks: [] }
                    const settle = (outcome, reason, message) => ({
                        type: 'marker',
                        kind: 'record',
                        bytes: docBytes,
                        position: settled,
                        record: { ...record, outcome, reason, message }
                    })
                    const reject = (error) => {
                        state.counters.errors += 1
                        const code = error.reason || error.code || 'parse_error'
                        return settle('rejected', code, errorMessage(error))
                    }
                    if (doc.reject) {
                        yield reject({ reason: doc.reject.reason, message: doc.reject.message })
                        continue
                    }
                    if (doc.error) {
                        yield reject({ reason: 'parse_error', message: doc.error })
                        continue
                    }
                    if (doc.filter) {
                        yield settle('filtered', doc.filter)
                        continue
                    }
                    state.counters.docsLoaded += 1
                    let shaped
                    let pieces
                    let docKey = doc.docKey || ''
                    try {
                        const stats = {}
                        shaped = transform(doc, stats)
                        state.coerce('nfc', stats.nfc || 0)
                        if (!shaped) {
                            state.counters.docsDropped += 1
                            yield settle('filtered', 'transform_min_chars')
                            continue
                        }
                        if (keyTemplate) {
                            docKey = normalizeKey(fillKeyTemplate(keyTemplate, shaped.metadata))
                            record.key = docKey
                        }
                        let metadata = shaped.metadata || {}
                        if (doc.loader) {
                            const flat = flattenLoaderMetadata(metadata)
                            metadata = flat.metadata
                            state.coerce('flattened', flat.flattened || 0)
                        }
                        metadata = finishMetadata(metadata, { caps: doc.caps, typed: doc.typed || {} })
                        const paths = stripServerPaths(metadata, prefixes)
                        state.coerce('pathRelativized', paths.relativized)
                        state.coerce('pathRedacted', paths.redacted)
                        let text = shaped.pageContent || ''
                        // E17: strict sources reject a lone surrogate, the others repair it with U+FFFD and count it.
                        if (doc.strict) {
                            if (!isWellFormed(docKey)) throw new RecordReject('invalid_unicode', 'key', 'the key holds a lone surrogate')
                            if (!isWellFormed(text)) throw new RecordReject('invalid_unicode', 'text', 'the text holds a lone surrogate')
                            for (const [field, value] of Object.entries(metadata))
                                if (typeof value === 'string' && !isWellFormed(value))
                                    throw new RecordReject('invalid_unicode', field, `${field} holds a lone surrogate`)
                        } else {
                            const fixed = repairUnicode(text)
                            text = fixed.text
                            state.coerce('replacementChars', fixed.replaced)
                            for (const [field, value] of Object.entries(metadata)) {
                                if (typeof value !== 'string') continue
                                const repaired = repairUnicode(value)
                                metadata[field] = repaired.text
                                state.coerce('replacementChars', repaired.replaced)
                            }
                        }
                        if (record.key) {
                            seedKeys()
                            if (seenKeys.has(record.key))
                                throw new RecordReject(
                                    'duplicate_key',
                                    null,
                                    `key "${clipText(record.key, 80)}" already appeared in this run`
                                )
                            seenKeys.add(record.key)
                        }
                        shaped = { ...shaped, pageContent: text, metadata }
                    } catch (error) {
                        if (!(error instanceof RecordReject)) throw error
                        yield reject(error)
                        continue
                    }
                    try {
                        pieces = await splitDoc(splitter, shaped)
                    } catch (error) {
                        state.event('warn', 'split', `${unit.key}: ${errorMessage(error)}`)
                        yield reject({ reason: 'split_error', message: errorMessage(error) })
                        continue
                    }
                    const kept = []
                    for (const piece of pieces) {
                        if (!piece || !piece.trim()) continue
                        const fixed = repairUnicode(piece)
                        state.coerce('replacementChars', fixed.replaced)
                        kept.push(fixed.text)
                    }
                    if (kept.length < pieces.length && kept.length) {
                        state.counters.split = { emptyPieces: (state.counters.split?.emptyPieces || 0) + pieces.length - kept.length }
                    }
                    if (!kept.length) {
                        yield settle('filtered', 'empty_text')
                        continue
                    }
                    for (let ci = 0; ci < kept.length; ci += 1) {
                        const text = kept[ci]
                        const metadata = { ...shaped.metadata, chunk: ci + 1 }
                        const last = ci === kept.length - 1
                        const chunk = {
                            type: 'chunk',
                            id: chunkId(pipeline.id, unit.sourceId, docKey, text, metadata, embedFp, ci),
                            sourceId: unit.sourceId,
                            fingerprint: unit.fingerprint,
                            docKey: record.key,
                            recordRef: `${unit.sourceId}\0${ordinal}`,
                            text,
                            metadata,
                            bytes: last ? docBytes : 0,
                            position: last ? settled : replay
                        }
                        record.chunks.push(chunk)
                        if (last) chunk.record = { ...record, outcome: 'written' }
                        chunks += 1
                        state.counters.chunks += 1
                        yield chunk
                    }
                }
            } catch (error) {
                if (error?.code === 'aborted') return
                // A missing key column, a bad header or a duplicate header is a pipeline problem: the run fails.
                if (error?.fatal || isCrash(error)) throw error
                // A unit that cannot be read keeps its old chunks: mark them seen so the sweep does not delete them.
                markSourceSeen(pipeline.id, run.id, unit.sourceId)
                state.counters.unitsFailed += 1
                state.counters.errors += 1
                state.event('error', 'load', `${unit.key}: ${errorMessage(error)}`)
                yield { ...done, kind: 'failed', bytes: Math.max(0, (unit.bytes || 0) - bytes) }
                continue
            }
            const rest = resumeAt ? 0 : Math.max(0, (unit.bytes || 0) - bytes)
            yield { ...done, kind: 'unitEnd', sourceId: unit.sourceId, fingerprint: unit.fingerprint, chunks, bytes: rest }
        }
    }
}

async function sweep({ pipeline, run, store, state, control, settings }) {
    state.checkpoint = { phase: 'sweep' }
    state.step('sweep', { status: 'running' })
    state.persist(true)
    const select = stmt('SELECT chunk_id FROM records WHERE pipeline_id = ? AND (seen_run IS NULL OR seen_run != ?) LIMIT ?')
    for (;;) {
        if (control.stopRequested) return false
        const ids = select.all(pipeline.id, run.id, SWEEP_BATCH).map((row) => row.chunk_id)
        if (!ids.length) break
        await retrying(() => store.delete(ids), { maxRetries: settings.maxRetries, signal: control.signal })
        tx(() => {
            stmt(`DELETE FROM records WHERE pipeline_id = ? AND chunk_id IN (${inList(ids.length)})`).run(pipeline.id, ...ids)
        })
        state.counters.deleted += ids.length
        state.step('sweep', { deleted: state.counters.deleted })
        state.persist()
        await yieldToLoop()
    }
    stmt('DELETE FROM sources WHERE pipeline_id = ? AND (seen_run IS NULL OR seen_run != ?)').run(pipeline.id, run.id)
    state.step('sweep', { status: 'done', deleted: state.counters.deleted })
    return true
}

function parseFingerprint(text) {
    if (!text) return null
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

// The single execution seam. A later queue version calls this from a worker for a run id it dequeued.
export async function executeRun(runId, { ctx = {}, control = { stopRequested: null } } = {}) {
    let run = getRun(runId)
    if (!run) throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
    const pipeline = getPipeline(run.pipelineId)
    const version = getVersion(run.pipelineId, run.version)
    if (!pipeline || !version) throw new EtlError('not_found', 'The pipeline or its version was deleted.', 404)
    const problems = version.problems?.problems || []
    const state = new RunState(run)
    const settings = run.settings
    const fail = (error) => {
        state.persist(true)
        updateRun(run.id, { status: 'failed', error: errorMessage(error), summary: state.summary(), finishedAt: new Date().toISOString() })
        state.event('error', null, errorMessage(error))
    }
    if (problems.length) {
        fail(new EtlError('bad_pipeline', problems.join(' ')))
        return getRun(run.id)
    }
    const spec = version.spec
    updateRun(run.id, {
        status: 'running',
        startedAt: run.startedAt || new Date().toISOString(),
        pipelineName: pipeline.name,
        error: null
    })
    state.event(
        'info',
        null,
        run.checkpoint ? `Resumed from checkpoint (attempt ${run.attempt}).` : `Started ${run.mode} run of version ${run.version}.`
    )

    let store
    try {
        const embedFp = embeddingFingerprint(spec.embeddings)
        const fingerprint = { embed: embedFp, store: storeFingerprint(spec.store, pipeline.name) }
        const embeddings = await createEmbeddings(spec.embeddings, ctx)
        store = await openStore(spec.store, {
            pipelineName: pipeline.name,
            pipelineId: pipeline.id,
            embeddings,
            ctx,
            onStale: (ids, error) =>
                state.event(
                    'warn',
                    'store',
                    `${ids.length} stale vector ids could not be deleted (${errorMessage(
                        error
                    )}); they are kept and deleted on the next run.`
                )
        })
        // Preflight before the first read (and before any local bookkeeping changes), so a bad credential, index or
        // namespace fails the run with 0 reads.
        if (store.preflight) await preflightStore(store, { settings, control })
        const previous = parseFingerprint(pipeline.indexFingerprint)
        if (!run.checkpoint && previous) {
            if (previous.store !== fingerprint.store) {
                tx(() => {
                    stmt('DELETE FROM records WHERE pipeline_id = ?').run(pipeline.id)
                    stmt('DELETE FROM sources WHERE pipeline_id = ?').run(pipeline.id)
                })
                state.event('info', 'store', `The target changed to ${store.label}; every chunk is written there.`)
            } else if (previous.embed !== fingerprint.embed && spec.store.nodeName === LOCAL_STORE) {
                await store.reset()
                tx(() => {
                    stmt('DELETE FROM records WHERE pipeline_id = ?').run(pipeline.id)
                    stmt('DELETE FROM sources WHERE pipeline_id = ?').run(pipeline.id)
                })
                state.event('info', 'embed', 'The embeddings model changed; the local collection is rebuilt.')
            } else if (previous.embed !== fingerprint.embed) {
                state.event(
                    'info',
                    'embed',
                    'The embeddings model changed; every chunk is re-embedded and old vectors are deleted at the end.'
                )
            }
        }

        // One-time heal for a pipeline last written before the store-count check existed (E9a), or whose last
        // run could not verify the store either way (store_unverified): sources whose vectors are missing are
        // re-embedded in this run instead of being reported unchanged.
        if (!run.checkpoint && previous && previous.store === fingerprint.store && previous.storeCount !== STORE_COUNT_MARK) {
            if (previous.storeCount === STORE_COUNT_VERIFY)
                state.event('info', 'store', 'The last run could not verify the store; verifying it before this run starts.')
            const before = await checkStoreCount({ pipeline, spec, store, state, ctx })
            if (before.mismatch) {
                state.event('warn', 'store', `${mismatchText(before.mismatch)} They are re-embedded in this run.`)
                state.counters.storeCountBefore = state.counters.storeCount
            } else if (before.unverified) state.event('warn', 'store', unverifiedText(before.unverified).replace(/ Previous .*$/, ''))
            else if (before.warning) state.event('warn', 'store', before.warning)
            delete state.counters.storeCount
        }

        // Source fingerprints as the run found them, restored if the run fails store_count_unverified.
        const fingerprintsBefore = new Map(
            stmt('SELECT source_id, fingerprint FROM sources WHERE pipeline_id = ?')
                .all(pipeline.id)
                .map((row) => [row.source_id, row.fingerprint])
        )
        const sweeping = run.checkpoint?.phase === 'sweep'
        if (!sweeping && !state.counters.unitsTotal && !state.counters.bytesTotal) {
            for (const source of spec.sources) {
                const estimate = await estimateSource(source, { ...ctx, pipelineId: pipeline.id, workspaceId: pipeline.workspaceId })
                if (estimate) {
                    state.counters.unitsTotal += estimate.units
                    state.counters.bytesTotal += estimate.bytes
                } else state.counters.unitsTotal += 1
            }
        }
        state.persist(true)

        if (!sweeping) {
            const embedder = new Embedder(embeddings, {
                concurrency: settings.concurrency,
                maxRetries: settings.maxRetries,
                signal: control.abort?.signal,
                onRetry: ({ attempt, kind, delayMs, error }) => {
                    state.counters.retries += 1
                    state.event(
                        'warn',
                        'embed',
                        `Retry ${attempt} after ${kind === 'rate_limit' ? 'a rate limit' : 'an error'} in ${delayMs} ms: ${errorMessage(
                            error
                        )}`
                    )
                }
            })
            await pump({ spec, pipeline, run, state, ctx, embedFp, control, embedder, store, settings })
            if (control.stopRequested) {
                const status = control.stopRequested === 'cancel' ? 'cancelled' : 'paused'
                state.persist(true)
                updateRun(run.id, { status, ...(status === 'cancelled' ? { finishedAt: new Date().toISOString() } : {}) })
                state.event('info', null, status === 'paused' ? 'Paused at the last committed batch.' : 'Cancelled. Nothing was deleted.')
                return getRun(run.id)
            }
            for (const name of ['load', 'transform', 'split', 'embed', 'store']) state.step(name, { status: 'done' })
            state.ledger.assertBalanced('the end of the run')
            // O9 gate: too many rejects ends the run `failed` before the sweep, so nothing is deleted, the served
            // version stays, and the sources this run read are re-read next time.
            const gate = rejectRatioGate(state.ledger, settings)
            if (gate) {
                restoreFingerprints(pipeline.id, run.id, fingerprintsBefore)
                throw new EtlError('reject_ratio_exceeded', gate)
            }
        }
        const endsPartial = isPartial(state)
        // Legacy records (written before record keys, doc_key NULL) can't be matched to a rejected key, so only a run
        // that ends `succeeded` may sweep them (O6). A partial run marks them seen and counts them as kept.
        if (endsPartial) {
            const kept = keepLegacyRecords(pipeline.id, run.id)
            if (kept) {
                state.counters.staleKept = (state.counters.staleKept || 0) + kept
                state.counters.legacyKept = (state.counters.legacyKept || 0) + kept
            }
        }

        // The count check runs before the sweep, so a run that fails it deletes nothing.
        const counted = await checkStoreCount({ pipeline, spec, store, state, ctx })
        if (counted.mismatch) throw new EtlError('store_count_mismatch', mismatchText(counted.mismatch))
        if (counted.unverified) {
            restoreFingerprints(pipeline.id, run.id, fingerprintsBefore)
            throw new EtlError('store_count_unverified', unverifiedText(counted.unverified))
        }
        if (counted.warning) state.event('warn', 'store', counted.warning)
        const finished = await sweep({ pipeline, run, store, state, control, settings })
        if (!finished) {
            const status = control.stopRequested === 'cancel' ? 'cancelled' : 'paused'
            state.persist(true)
            updateRun(run.id, { status })
            return getRun(run.id)
        }
        fingerprint.storeCount = counted.verifyNext ? STORE_COUNT_VERIFY : STORE_COUNT_MARK
        setServedVersion(pipeline.id, run.version, JSON.stringify(fingerprint))
        state.checkpoint = { phase: 'done' }
        state.live.etaSeconds = 0
        state.persist(true)
        const c = state.counters
        const summary = state.summary()
        // Spec 5.3.3: `partial` read to the end with the ledger balanced, under the reject-ratio gate, with rejects,
        // failed units or possible duplicates. It is served (O9). The rejects table is still E11.
        const status = endsPartial ? 'partial' : 'succeeded'
        updateRun(run.id, { status, summary, finishedAt: new Date().toISOString() })
        const kept = c.staleKept ? `, ${c.staleKept} keys kept their last good version` : ''
        state.event(
            'info',
            null,
            `${status === 'partial' ? 'Partial' : 'Succeeded'}: ${summary.read} records read, ${summary.written.inserted} new, ${
                summary.written.unchanged
            } unchanged, ${summary.rejected.total} rejected, ${summary.filtered.total} filtered${kept}; ${c.embedded} chunks embedded, ${
                c.skipped
            } unchanged, ${c.deleted} deleted, ${c.unitsSkipped} sources unchanged.`
        )
    } catch (error) {
        // A simulated kill (etl:check) leaves the run as a real one would: running, with its last checkpoint.
        if (isCrash(error)) throw error
        if (control.stopRequested && error?.code === 'aborted') {
            state.persist(true)
            updateRun(run.id, { status: control.stopRequested === 'cancel' ? 'cancelled' : 'paused' })
        } else fail(error)
    }
    run = getRun(run.id)
    return run
}

async function pump({ spec, pipeline, run, state, ctx, embedFp, control, embedder, store, settings }) {
    const inflight = new Set()
    const completed = new Map()
    let seq = 0
    let nextCommit = 0
    let fatal = null
    const newBatch = () => ({ chunks: [], markers: [], records: [], position: null, bytes: 0 })
    const ledger = state.ledger

    // Applies one record's ledger entry. A chunk-bearing record is written unless the store rejected one of its chunks.
    const applyRecord = (record) => {
        ledger.read(record.nodeId)
        let { outcome, reason, message } = record
        if (outcome === 'written') {
            const bad = record.chunks.find((chunk) => chunk.storeError)
            if (bad) {
                outcome = 'rejected'
                reason = 'store_rejected'
                message = bad.storeError
                state.storeRejectedSources.add(record.sourceId)
            }
        }
        if (outcome === 'written') {
            ledger.written(record.nodeId, { inserted: record.chunks.some((chunk) => chunk.fresh) })
            return
        }
        if (outcome === 'filtered') {
            ledger.filtered(record.nodeId, reason)
            return
        }
        ledger.rejected(record.nodeId, reason)
        if (record.key && run.mode !== 'full' && reason !== 'duplicate_key' && reason !== 'store_rejected') {
            if (keepLastGood(pipeline.id, run.id, record.sourceId, record.key))
                state.counters.staleKept = (state.counters.staleKept || 0) + 1
        }
        state.rejectEvents += 1
        if (state.rejectEvents <= REJECT_EVENTS) {
            const key = record.key ? ` (key "${clipText(record.key, 80)}")` : ''
            state.event(
                'warn',
                'load',
                clipText(`${record.unitKey} record ${record.ordinal}${key} rejected: ${reason}: ${message || reason}`, 2000)
            )
        } else if (state.rejectEvents === REJECT_EVENTS + 1)
            state.event('warn', 'load', `More than ${REJECT_EVENTS} records were rejected; the run summary counts them all.`)
    }

    const commitReady = () => {
        while (completed.has(nextCommit)) {
            const batch = completed.get(nextCommit)
            completed.delete(nextCommit)
            nextCommit += 1
            // Records first: a unit's records always come before its unitEnd marker.
            for (const record of batch.records) applyRecord(record)
            const miscount = fault(ctx, 'ledger', batch)
            if (miscount) ledger.read(miscount.nodeId, miscount.n || 1)
            for (const marker of batch.markers) {
                if (marker.kind === 'unitEnd') {
                    // A unit with a store-rejected record keeps its previous fingerprint, so the next run re-reads it,
                    // and keeps its old records, so the previous version of the rejected record keeps serving (E17).
                    if (state.storeRejectedSources.has(marker.sourceId)) markSourceSeen(pipeline.id, run.id, marker.sourceId)
                    else saveSource(pipeline.id, run.id, marker)
                    state.counters.unitsDone += 1
                } else if (marker.kind === 'skipped') {
                    state.counters.unitsDone += 1
                    state.counters.unitsSkipped += 1
                } else if (marker.kind === 'failed' || marker.kind === 'ignored') state.counters.unitsDone += 1
            }
            if (batch.position) state.checkpoint = batch.position
            state.counters.bytesRead += batch.bytes
            state.counters.batches += 1
            try {
                ledger.assertBalanced(`batch ${batch.seq + 1}`)
            } catch (error) {
                if (!fatal) fatal = error
                break
            }
        }
        state.persist()
    }

    // Upserts with bisection (E17): a 400/413/422 that names a payload problem is split until the bad chunk is
    // isolated. Gives the indexes the store confirmed and the rejected ones with their errors. Anything else throws.
    const writeChunks = async (fresh, vectors) => {
        const ok = []
        const bad = new Map()
        const attempt = async (lo, hi) => {
            const slice = fresh.slice(lo, hi)
            try {
                await retrying(
                    () =>
                        store.upsert(
                            slice.map((chunk) => chunk.id),
                            vectors.slice(lo, hi),
                            slice.map((chunk) => ({ pageContent: chunk.text, metadata: chunk.metadata }))
                        ),
                    { maxRetries: settings.maxRetries, signal: control.abort?.signal, classify: classifyStoreError }
                )
                for (let i = lo; i < hi; i += 1) ok.push(i)
            } catch (error) {
                const kind = classifyStoreError(error)
                if (kind === 'config') throw storeConfigError(error)
                if (kind !== 'record' || legacyDeleteFirst(ctx)) throw error
                if (hi - lo === 1) {
                    bad.set(lo, error)
                    return
                }
                const mid = lo + Math.ceil((hi - lo) / 2)
                await attempt(lo, mid)
                await attempt(mid, hi)
            }
        }
        await attempt(0, fresh.length)
        return { ok, bad }
    }

    const failBatch = (fresh, error) => {
        // Nothing of this batch is recorded, and its sources are not marked synced. The test-only
        // legacyDeleteFirst fault turns this off too, so etl:check can show the count check alone.
        if (!legacyDeleteFirst(ctx)) {
            const sources = flagFailedSources(pipeline.id, fresh)
            state.event(
                'warn',
                'store',
                `Store write failed for ${fresh.length} chunks; sources ${sources.join(', ')} are re-read next run.`
            )
        }
        throw error
    }

    const prefixes = process.env.ETL_CHECK === '1' ? serverPrefixes() : null

    const processBatch = async (batch) => {
        const unique = new Map()
        for (const chunk of batch.chunks) unique.set(chunk.id, chunk)
        const chunks = [...unique.values()]
        if (!chunks.length) return
        const existing =
            run.mode === 'full'
                ? new Set()
                : lookupExisting(
                      pipeline.id,
                      chunks.map((chunk) => chunk.id)
                  )
        const unchanged = chunks.filter((chunk) => existing.has(chunk.id))
        const fresh = chunks.filter((chunk) => !existing.has(chunk.id))
        markSeen(
            pipeline.id,
            run.id,
            unchanged.map((chunk) => chunk.id)
        )
        state.counters.skipped += unchanged.length + (batch.chunks.length - chunks.length)
        if (!fresh.length) return
        // etl:check guard (E16): no absolute server path reaches the store.
        if (prefixes) {
            for (const chunk of fresh) {
                const key = findServerPath(chunk.metadata, prefixes)
                if (key) throw new EtlError('server_path_leak', `metadata.${key} of ${chunk.sourceId} holds an absolute server path.`)
            }
        }
        state.step('embed', { status: 'running' })
        const t0 = Date.now()
        const vectors = await embedder.embed(fresh.map((chunk) => chunk.text))
        const t1 = Date.now()
        state.counters.embedMs += t1 - t0
        state.step('store', { status: 'running' })
        let written
        try {
            written = await writeChunks(fresh, vectors)
        } catch (error) {
            failBatch(fresh, error)
        }
        // Every chunk failed on its own: not a record problem (a store-wide schema problem, say), so the run fails.
        if (!written.ok.length) failBatch(fresh, written.bad.values().next().value)
        let confirmed = written.ok.map((i) => fresh[i])
        if (written.bad.size) {
            const badRefs = new Map()
            for (const [i, error] of written.bad) {
                const message = storeError(error)
                fresh[i].storeError = message
                if (!badRefs.has(fresh[i].recordRef)) badRefs.set(fresh[i].recordRef, message)
            }
            // The rest of a rejected record's chunks in this batch come out again, so its previous version serves whole.
            const siblings = confirmed.filter((chunk) => badRefs.has(chunk.recordRef))
            if (siblings.length) {
                await retrying(() => store.delete(siblings.map((chunk) => chunk.id)), {
                    maxRetries: settings.maxRetries,
                    signal: control.abort?.signal
                })
                for (const chunk of siblings) chunk.storeError = badRefs.get(chunk.recordRef)
                confirmed = confirmed.filter((chunk) => !badRefs.has(chunk.recordRef))
            }
            state.counters.errors += badRefs.size
            state.event(
                'warn',
                'store',
                `The store rejected ${written.bad.size} of ${fresh.length} chunks; ${badRefs.size} records are rejected as store_rejected and the rest of the batch is written.`
            )
        }
        for (const chunk of confirmed) chunk.fresh = true
        // Duplicates of a chunk id in this batch share the outcome of the copy that was sent.
        for (const chunk of batch.chunks) {
            const sent = unique.get(chunk.id)
            if (sent !== chunk) {
                chunk.fresh = sent.fresh
                chunk.storeError = sent.storeError
            }
        }
        state.counters.storeMs += Date.now() - t1
        insertRecords(pipeline.id, run.id, confirmed)
        state.counters.embedded += confirmed.length
    }

    const dispatch = async (batch) => {
        batch.seq = seq
        seq += 1
        while (inflight.size >= settings.concurrency) await Promise.race(inflight)
        const task = processBatch(batch)
            .then(
                () => {
                    completed.set(batch.seq, batch)
                    commitReady()
                },
                (error) => {
                    if (!fatal) fatal = error
                }
            )
            .finally(() => inflight.delete(task))
        inflight.add(task)
    }

    let batch = newBatch()
    const flushLimit = settings.batchSize * 8
    state.step('transform', { status: 'running' })
    state.step('split', { status: 'running' })
    try {
        for await (const item of produce({ spec, pipeline, run, state, ctx, embedFp, control })) {
            if (control.stopRequested || fatal) break
            if (item.type === 'chunk') batch.chunks.push(item)
            else batch.markers.push(item)
            if (item.record) batch.records.push(item.record)
            batch.position = item.position
            batch.bytes += item.bytes || 0
            if (state.counters.errors > settings.maxErrors) {
                fatal = new EtlError(
                    'too_many_errors',
                    `Stopped after ${state.counters.errors} document errors (limit ${settings.maxErrors}).`
                )
                break
            }
            if (batch.chunks.length >= settings.batchSize || batch.markers.length >= flushLimit) {
                await dispatch(batch)
                batch = newBatch()
                state.step('load', { docs: state.counters.docsLoaded, units: state.counters.unitsDone })
                state.persist()
                await yieldToLoop()
            }
        }
    } catch (error) {
        if (!fatal) fatal = error
    }
    if (!control.stopRequested && !fatal && (batch.chunks.length || batch.markers.length)) await dispatch(batch)
    await Promise.all(inflight)
    commitReady()
    state.step('load', { docs: state.counters.docsLoaded, units: state.counters.unitsDone })
    if (fatal) {
        for (const name of ['embed', 'store']) if (state.steps[name].status === 'running') state.step(name, { status: 'failed' })
        throw fatal
    }
}
