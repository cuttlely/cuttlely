// Ordinary admission, save/delete, and maintenance retain their common PostgreSQL queue writer fence.
// Equal timestamps permit either oldest job in the serial queue. Resolve such ties identically in
// both reads of the preview. An incompatible or unexamined queue head is never skipped.
const queuedHead = "SELECT id FROM jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1"

// Undefined means the queue can be polled again. False means a queued job must wait for a free worker.
export function inspectHead(db, classify) {
    const row = db.prepare(`SELECT id,payload FROM jobs WHERE id=(${queuedHead})`).get()
    if (!row) return
    let payload
    try {
        payload = JSON.parse(row.payload)
    } catch {
        return false
    }
    const selected = classify({ id: row.id, payload })
    return selected ? { id: row.id, payloadBytes: row.payload, selected } : false
}

export function claimInspectedHead(db, inspected) {
    const { id, payloadBytes, selected } = inspected
    // Both text comparisons are byte-exact even with a case-insensitive database collation.
    // A direct concurrent UPDATE/DELETE of the existing roster row must finish before it can qualify.
    // The generic adapter takes the unchanged exclusive queue writer fence before this statement.
    const sql = `UPDATE jobs SET status='running',updated_at=?
        WHERE id=? AND status='queued' AND payload COLLATE "C"=? AND id=(${queuedHead})
          AND EXISTS (SELECT 1 FROM harness_records WHERE entry=? AND content COLLATE "C"=? FOR SHARE)
        RETURNING id,payload,cancel_requested`
    let row
    try {
        row = db.prepare(sql).get(Date.now(), id, payloadBytes, selected.entry, selected.content)
    } catch (error) {
        // A SELECT-only role may have no tuple-lock privilege on the roster. Leave this job queued
        // until it can run alone under the normal reader policy.
        if (error.code === '42501') return false
        throw error
    }
    if (row)
        return {
            job: { id: row.id, payload: JSON.parse(row.payload), cancelRequested: row.cancel_requested === 1 },
            record: selected.record
        }
}

// A noneligible head can run only when the current worker has drained its other turn.
export async function pumpPair({ stopped, claim, peekAndClaim, classify, execute, wait, wake }) {
    const active = new Set()
    let exclusive = false
    let idlePoll = false
    function launch(job, record) {
        exclusive = !record
        const pending = (async () => execute(job, record))()
            .catch(() => {
                // executeJob persists the failure on this exact job.
            })
            .finally(() => {
                active.delete(pending)
                if (!active.size) exclusive = false
                wake()
            })
        active.add(pending)
    }
    try {
        while (!stopped()) {
            if (active.size === 2 || exclusive) {
                await wait(false)
                continue
            }
            if (active.size) {
                const next = peekAndClaim()
                if (next) {
                    launch(next.job, next.record)
                    continue
                }
                if (next === false) {
                    // Do not poll the same incompatible roster during a slow in-flight call.
                    await wait(false)
                    continue
                }
            } else {
                const job = claim(idlePoll)
                if (job) {
                    idlePoll = false
                    launch(job, classify(job))
                    continue
                }
            }
            idlePoll = await wait(true)
        }
    } finally {
        // A shutdown or a fatal claim error closes the listener/storage only after every accepted job settles.
        await Promise.allSettled(active)
    }
}

export function runExternalWorkerPair({ database, jobsStopped, claimJob, pairedWorkerRecord, ...lifecycle }) {
    function classify(job) {
        try {
            return pairedWorkerRecord(job)
        } catch {
            // The ordinary exclusive dispatch reports any invalid roster, access or storage error.
            return undefined
        }
    }
    function peekAndClaim() {
        if (jobsStopped()) return
        const db = database()
        const inspected = inspectHead(db, classify)
        if (!inspected || jobsStopped()) return inspected === false ? false : undefined
        return claimInspectedHead(db, inspected)
    }
    return pumpPair({ ...lifecycle, claim: claimJob, peekAndClaim, classify: (job) => classify(job)?.record })
}
