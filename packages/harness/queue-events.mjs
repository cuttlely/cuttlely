import { HarnessError } from './errors.mjs'
import { database, immediate } from './lock.mjs'

export function appendJobEvent(db, id, event) {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id = ?').get(id)
    db.prepare('INSERT INTO job_events (job_id, seq, event) VALUES (?, ?, ?)').run(id, Number(row?.seq || 0) + 1, JSON.stringify(event))
}

function assertToolJob(job, phase) {
    if (job?.status !== 'running') throw new HarnessError('worker_lost', 'The harness job no longer owns this turn.')
    if (phase !== 'confirmed' && job.cancel_requested) throw new HarnessError('aborted', 'Client disconnected')
}

function storeEvent(id, event, phase = null) {
    const db = database()
    if (db.dialect === 'postgres') {
        const job = db.appendJobEvent(id, JSON.stringify(event), phase)
        if (phase) assertToolJob(job, phase)
        return
    }
    immediate((tx) => {
        if (phase) assertToolJob(tx.prepare('SELECT status, cancel_requested FROM jobs WHERE id = ?').get(id), phase)
        appendJobEvent(tx, id, event)
        tx.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
}

export function appendEvent(id, event) {
    storeEvent(id, event)
}

export function recordToolPhase(id, { callId, specialist, name, phase }) {
    storeEvent(id, { type: 'nativeToolReceipt', callId, specialist, name, phase }, phase)
}
