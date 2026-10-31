/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import type { DataSource, QueryRunner } from 'typeorm'

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'
let converged = false

function dialect(runner: QueryRunner): Dialect {
    const value = runner.connection.options.type
    return value === 'postgres' || value === 'mysql' || value === 'mariadb' ? value : 'sqlite'
}

function q(d: Dialect, name: string): string {
    return d === 'mysql' || d === 'mariadb' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'
}

function databaseDate(d: Dialect, value: Date): Date | number {
    return d === 'sqlite' ? value.getTime() : value
}

function rows(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) return result[0] as Record<string, unknown>[]
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : []
}

function inserted(result: unknown): boolean {
    if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') return result[1] > 0
    return Boolean(result && typeof result === 'object' && Number((result as { affectedRows?: unknown }).affectedRows) > 0)
}

/**
 * Writes the release cutoff once. A unique singleton row makes concurrent starts converge on the same marker.
 * The marker is deliberately not an exchange point: old sealed cookies are never turned into database sessions.
 */
export async function activateSessionConvergence(
    dataSource: DataSource,
    now = Date.now()
): Promise<{ created: boolean; cutoffAt: string }> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const d = dialect(runner)
        const table = q(d, 'identity_session_convergence')
        let result: unknown
        if (d === 'postgres') {
            result = await runner.query(
                `INSERT INTO ${table} (${q(d, 'id')}, ${q(d, 'cutoffAt')}) VALUES (1, $1) ON CONFLICT (${q(
                    d,
                    'id'
                )}) DO NOTHING RETURNING ${q(d, 'id')}`,
                [databaseDate(d, new Date(now))]
            )
        } else if (d === 'sqlite') {
            await runner.query(`INSERT OR IGNORE INTO ${table} (${q(d, 'id')}, ${q(d, 'cutoffAt')}) VALUES (1, ?)`, [
                databaseDate(d, new Date(now))
            ])
            result = await runner.query('SELECT changes() AS changed')
        } else {
            result = await runner.query(`INSERT IGNORE INTO ${table} (${q(d, 'id')}, ${q(d, 'cutoffAt')}) VALUES (1, ?)`, [
                databaseDate(d, new Date(now))
            ])
        }
        const selected = rows(await runner.query(`SELECT ${q(d, 'cutoffAt')} AS ${q(d, 'cutoffAt')} FROM ${table} WHERE ${q(d, 'id')} = 1`))
        const value = selected[0]?.cutoffAt ?? selected[0]?.CUTOFFAT
        const cutoffAt = new Date(
            typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : (value as string | number | Date)
        ).toISOString()
        converged = true
        const created =
            d === 'sqlite' ? Number(rows(result)[0]?.changed || 0) > 0 : d === 'postgres' ? rows(result).length > 0 : inserted(result)
        return { created, cutoffAt }
    } finally {
        await runner.release()
    }
}

export function sessionConvergenceActive(): boolean {
    return converged
}

export function resetSessionConvergenceForTests(): void {
    converged = false
}
