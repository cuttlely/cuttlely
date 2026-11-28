import { createHash } from 'crypto'
import type { DataSource } from 'typeorm'

/**
 * Each statement counts against the UTC minute in which PostgreSQL received it.
 * The primary key orders older windows first, including callers who never return.
 * Expired rows are collected in small batches without waiting for other cleaners.
 */
export async function claimHarnessRequest(data: DataSource, kind: 'read' | 'start' | 'schedule', caller: string, limit: number) {
    if (data.options.type !== 'postgres') throw new Error('Shared harness request limits require PostgreSQL.')
    const digest = createHash('sha256').update(caller).digest()
    const [row] = await data.query(
        `WITH current_window AS MATERIALIZED (
            SELECT floor(extract(epoch FROM statement_timestamp()) / 60)::bigint AS minute
        ), expired AS (
            DELETE FROM harness_request_window
            WHERE (minute, kind, caller) IN (
                SELECT w.minute, w.kind, w.caller FROM harness_request_window w, current_window t
                WHERE w.minute < t.minute - 1 ORDER BY w.minute, w.kind, w.caller
                LIMIT 32 FOR UPDATE OF w SKIP LOCKED
            )
        ), admission AS (
            INSERT INTO harness_request_window AS w (minute, kind, caller, hits)
            SELECT minute, $1, $2, 1 FROM current_window
            ON CONFLICT (minute, kind, caller) DO UPDATE SET hits = w.hits + 1 WHERE w.hits < $3
            RETURNING hits
        )
        SELECT (SELECT hits FROM admission) AS hits,
            greatest(1, ceil((minute + 1) * 60 - extract(epoch FROM clock_timestamp())))::integer AS seconds
        FROM current_window`,
        [kind, digest, limit]
    )
    return { accepted: row.hits !== null, remaining: row.hits === null ? 0 : limit - row.hits, resetSeconds: row.seconds }
}
