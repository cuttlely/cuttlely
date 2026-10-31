/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { randomUUID } from 'crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import logger from '../utils/logger'
import { sendSmtp, smtpReady } from './actionLink'
import { organizationsForUser, recordAudit } from './auditLog'
import type { Sql } from './directory'

export type RecoveryOutcome = 'success' | 'wrong_credential' | 'throttled'

export interface RecoveryAlert {
    id: string
    occurredAt: string
}

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

function dialect(runner: QueryRunner): Dialect {
    const value = runner.connection.options.type
    return value === 'postgres' || value === 'mysql' || value === 'mariadb' ? value : 'sqlite'
}

function q(d: Dialect | Sql['type'], name: string): string {
    return d === 'mysql' || d === 'mariadb' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'
}

function cell(row: Record<string, unknown>, name: string): unknown {
    const key = Object.keys(row).find((item) => item.toLowerCase() === name.toLowerCase())
    return key ? row[key] : undefined
}

function dbDate(d: Dialect, at: number): Date | number {
    return d === 'sqlite' ? at : new Date(at)
}

function summary(outcome: RecoveryOutcome): string {
    if (outcome === 'success') return 'Owner recovery sign-in succeeded'
    if (outcome === 'throttled') return 'Owner recovery sign-in throttled'
    return 'Owner recovery sign-in failed'
}

/** Recovery audit is mandatory. A database failure stops the recovery route instead of silently omitting the event. */
export async function recordRecoveryAttempt(
    sql: Sql,
    input: { outcome: RecoveryOutcome; userId: string | null; at: number }
): Promise<void> {
    const organizations = input.userId ? await organizationsForUser(sql, input.userId) : []
    for (const organizationId of organizations.length ? organizations : ['']) {
        await recordAudit(sql, {
            type: 'owner_recovery',
            organizationId,
            workspaceId: null,
            userId: input.outcome === 'success' ? input.userId : null,
            actorId: input.outcome === 'success' ? input.userId : null,
            summary: summary(input.outcome),
            detail: { severity: 'high', outcome: input.outcome },
            at: input.at
        })
    }
}

export async function createRecoveryAlert(dataSource: DataSource, userId: string, at: number): Promise<RecoveryAlert> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const id = randomUUID()
        await runner.query(
            `INSERT INTO ${q(d, 'identity_recovery_alert')} (${q(d, 'id')}, ${q(d, 'userId')}, ${q(d, 'occurredAt')}, ${q(
                d,
                'acknowledgedAt'
            )}, ${q(d, 'acknowledgedBy')}) VALUES (${d === 'postgres' ? '$1, $2, $3, NULL, NULL' : '?, ?, ?, NULL, NULL'})`,
            [id, userId, dbDate(d, at)]
        )
        return { id, occurredAt: new Date(at).toISOString() }
    } finally {
        await runner.release()
    }
}

export async function currentRecoveryAlert(dataSource: DataSource): Promise<RecoveryAlert | null> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const result = await runner.query(
            `SELECT ${q(d, 'id')} AS ${q(d, 'id')}, ${q(d, 'occurredAt')} AS ${q(d, 'occurredAt')}
             FROM ${q(d, 'identity_recovery_alert')} WHERE ${q(d, 'acknowledgedAt')} IS NULL
             ORDER BY ${q(d, 'occurredAt')} DESC LIMIT 1`
        )
        const rows = Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) ? result[0] : result
        const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
        if (!row) return null
        const raw = cell(row, 'occurredAt')
        const numeric = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
        return { id: String(cell(row, 'id')), occurredAt: new Date(numeric as string | number | Date).toISOString() }
    } finally {
        await runner.release()
    }
}

export async function acknowledgeRecoveryAlert(
    _dataSource: DataSource,
    sql: Sql,
    input: { id: string; actorId: string; organizationId: string; at: number }
): Promise<boolean> {
    const d = sql.type
    return sql.transaction(async (query) => {
        const transaction: Sql = { type: d, query, transaction: async (run) => run(query) }
        const returning = d === 'postgres' ? ` RETURNING ${q(d, 'id')} AS ${q(d, 'id')}` : ''
        const updated = await query(
            `UPDATE ${q(d, 'identity_recovery_alert')} SET ${q(d, 'acknowledgedAt')} = ?, ${q(d, 'acknowledgedBy')} = ? WHERE ${q(
                d,
                'id'
            )} = ? AND ${q(d, 'acknowledgedAt')} IS NULL${returning}`,
            [d === 'sqlite' ? input.at : new Date(input.at), input.actorId, input.id]
        )
        const changed =
            d === 'postgres'
                ? updated.length > 0
                : Number(
                      cell(
                          (await query(d === 'sqlite' ? 'SELECT changes() AS changed' : 'SELECT ROW_COUNT() AS changed'))[0] || {},
                          'changed'
                      ) || 0
                  ) > 0
        if (!changed) return false
        await recordAudit(transaction, {
            type: 'owner_recovery',
            organizationId: input.organizationId,
            workspaceId: null,
            userId: input.actorId,
            actorId: input.actorId,
            summary: 'Owner recovery alert acknowledged',
            detail: { severity: 'high', outcome: 'acknowledged', alertId: input.id },
            at: input.at
        })
        return true
    })
}

async function activeOwnerEmails(sql: Sql): Promise<string[]> {
    const rows = await sql.query(
        `SELECT DISTINCT u.${q(sql.type, 'email')} AS ${q(sql.type, 'email')}
         FROM ${q(sql.type, 'user')} u
         INNER JOIN ${q(sql.type, 'organization_user')} ou ON ou.${q(sql.type, 'userId')} = u.${q(sql.type, 'id')}
         INNER JOIN ${q(sql.type, 'role')} r ON r.${q(sql.type, 'id')} = ou.${q(sql.type, 'roleId')}
         WHERE LOWER(u.${q(sql.type, 'status')}) = 'active'
           AND LOWER(ou.${q(sql.type, 'status')}) = 'active'
           AND LOWER(r.${q(sql.type, 'name')}) = 'owner'`
    )
    return rows.map((row) => String(cell(row, 'email') || '').trim()).filter(Boolean)
}

/** Structured log and owner email are best effort; the database alert and audit are created before this call. */
export async function notifyRecoverySuccess(sql: Sql, alert: RecoveryAlert): Promise<void> {
    logger.warn(
        JSON.stringify({ event: 'owner_recovery_sign_in', severity: 'high', outcome: 'success', alertId: alert.id, at: alert.occurredAt })
    )
    if (!smtpReady()) return
    const message = `An owner recovery sign-in completed at ${alert.occurredAt}. Open Admin > Auth / SSO to acknowledge this alert.`
    const results = await Promise.allSettled(
        (await activeOwnerEmails(sql)).map((to) => sendSmtp({ to, subject: 'Cuttlely owner recovery sign-in', text: message }))
    )
    if (results.some((result) => result.status === 'rejected'))
        logger.warn('[server]: one or more owner recovery messages could not be sent')
}
