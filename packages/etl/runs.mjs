import crypto from 'node:crypto'
import { now, parseJson } from './db.mjs'
import * as etlStore from './store.mjs'
import { truncateCodePoints } from './text.mjs'

export const ACTIVE_STATUSES = ['queued', 'running', 'pausing', 'cancelling']
// Terminal statuses (spec 5.3.3). `completed` is retired; E1 migrates old rows to `succeeded`.
export const TERMINAL_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled']
export const STEP_NAMES = ['load', 'transform', 'split', 'embed', 'store', 'sweep']
const EVENT_CAP = 500

export const DEFAULT_SETTINGS = {
    batchSize: 64,
    concurrency: 4,
    maxRetries: 6,
    maxErrors: 100,
    // O9 gate (spec 5.3.3): a run with more than this share of its records rejected, after at least
    // MIN_READS_FOR_RATIO reads, ends `failed` and is not served.
    maxRejectRatio: 0.05
}

export const MIN_READS_FOR_RATIO = 100

export function normalizeSettings(input = {}) {
    const pick = (key, min, max) => {
        const n = Math.floor(Number(input[key]))
        return Number.isFinite(n) && n >= min ? Math.min(n, max) : DEFAULT_SETTINGS[key]
    }
    return {
        batchSize: pick('batchSize', 1, 2048),
        concurrency: pick('concurrency', 1, 64),
        maxRetries: pick('maxRetries', 0, 20),
        maxErrors: pick('maxErrors', 0, 1000000),
        maxRejectRatio: ratio(input.maxRejectRatio)
    }
}

function ratio(value) {
    const n = Number(value)
    return value !== undefined && value !== null && value !== '' && Number.isFinite(n) && n >= 0 && n <= 1
        ? n
        : DEFAULT_SETTINGS.maxRejectRatio
}

export function emptySteps() {
    return Object.fromEntries(STEP_NAMES.map((name) => [name, { status: 'pending' }]))
}

export function emptyCounters() {
    return {
        unitsTotal: 0,
        unitsDone: 0,
        unitsSkipped: 0,
        unitsFailed: 0,
        bytesTotal: 0,
        bytesRead: 0,
        docsLoaded: 0,
        docsDropped: 0,
        chunks: 0,
        embedded: 0,
        skipped: 0,
        deleted: 0,
        batches: 0,
        retries: 0,
        errors: 0,
        embedMs: 0,
        storeMs: 0
    }
}

function runRow(row) {
    if (!row) return null
    return {
        id: row.id,
        pipelineId: row.pipeline_id,
        version: row.version,
        mode: row.mode,
        status: row.status === 'completed' ? 'succeeded' : row.status,
        settings: parseJson(row.settings, { ...DEFAULT_SETTINGS }),
        checkpoint: parseJson(row.checkpoint, null),
        counters: { ...emptyCounters(), ...parseJson(row.counters, {}) },
        steps: { ...emptySteps(), ...parseJson(row.steps, {}) },
        summary: parseJson(row.summary, null),
        error: row.error || null,
        attempt: row.attempt,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at
    }
}

export async function insertRun({ pipelineId, version, mode, settings }) {
    const id = crypto.randomUUID()
    const stamp = now()
    await etlStore.run(
        'INSERT INTO runs (id, pipeline_id, version, mode, status, settings, counters, steps, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [
            id,
            pipelineId,
            version,
            mode,
            'queued',
            JSON.stringify(settings),
            JSON.stringify(emptyCounters()),
            JSON.stringify(emptySteps()),
            stamp,
            stamp
        ]
    )
    return getRun(id)
}

// `q` is the store, or inside a transaction the transaction's handle.
export async function getRun(id, q = etlStore) {
    return runRow(await q.get('SELECT * FROM runs WHERE id = ?', [id]))
}

export async function listRuns(pipelineId, limit = 50) {
    return (
        await etlStore.all('SELECT * FROM runs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT ?', [pipelineId, Number(limit) || 50])
    ).map(runRow)
}

export async function runsWithStatus(statuses) {
    return (
        await etlStore.all(`SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at`, [...statuses])
    ).map(runRow)
}

export async function activeRunFor(pipelineId, q = etlStore) {
    return runRow(
        await q.get(
            `SELECT * FROM runs WHERE pipeline_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(
                ', '
            )}) ORDER BY created_at DESC LIMIT 1`,
            [pipelineId, ...ACTIVE_STATUSES]
        )
    )
}

export async function lastRunFor(pipelineId) {
    return runRow(await etlStore.get('SELECT * FROM runs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT 1', [pipelineId]))
}

export async function updateRun(id, fields, q = etlStore) {
    const columns = {
        status: fields.status,
        checkpoint: fields.checkpoint === undefined ? undefined : JSON.stringify(fields.checkpoint),
        counters: fields.counters === undefined ? undefined : JSON.stringify(fields.counters),
        steps: fields.steps === undefined ? undefined : JSON.stringify(fields.steps),
        summary: fields.summary === undefined ? undefined : JSON.stringify(fields.summary),
        error: fields.error,
        attempt: fields.attempt,
        started_at: fields.startedAt,
        finished_at: fields.finishedAt
    }
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined)
    entries.push(['updated_at', now()])
    await q.run(`UPDATE runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`, [
        ...entries.map(([, value]) => value),
        id
    ])
}

export async function addEvent(runId, level, step, message, q = etlStore) {
    const count = (await q.get('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?', [runId])).n
    if (count >= EVENT_CAP && level !== 'error') return
    await q.run('INSERT INTO run_events (run_id, ts, level, step, message) VALUES (?, ?, ?, ?, ?)', [
        runId,
        now(),
        level,
        step || null,
        truncateCodePoints(String(message), 2000)
    ])
}

export async function listEvents(runId, { after = 0, limit = 200 } = {}) {
    return (
        await etlStore.all('SELECT id, ts, level, step, message FROM run_events WHERE run_id = ? AND id > ? ORDER BY id DESC LIMIT ?', [
            runId,
            Number(after) || 0,
            Number(limit) || 200
        ])
    ).reverse()
}
