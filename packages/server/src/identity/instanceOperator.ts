// Host authority for service administration. Never add this designation to writable settings or tenant RBAC.
import { createHash } from 'crypto'
import path from 'path'
import fs from 'fs'
import { Request, RequestHandler } from 'express'
import { DataSourceOptions } from 'typeorm'
import { resolveTeamAccess } from './rbac'

export const INSTANCE_OPERATOR_KEY = 'CUTTLELY_INSTANCE_OPERATOR'
export const INSTANCE_OPERATOR_NOTICE = 'Only the instance operator can change server-wide settings'
type Env = Record<string, string | undefined>

function canonical(value: unknown): unknown {
    if (Buffer.isBuffer(value)) return value.toString('base64')
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, canonical(item)])
        )
    return value ?? null
}

/** Host CLI only. Hashes the running connection, never draft settings or identity rows. No raw credentials leave here. */
export function operatorDatabaseFingerprint(options: DataSourceOptions): string {
    const db = options as DataSourceOptions & {
        host?: string
        port?: number
        username?: string
        password?: string
        ssl?: unknown
        url?: string
    }
    let database = db.database
    if (db.type === 'sqlite') {
        const full = path.resolve(String(database))
        database = fs.existsSync(full) ? fs.realpathSync(full) : full
    }
    return createHash('sha256')
        .update(
            JSON.stringify(
                canonical({
                    version: 1,
                    type: db.type,
                    database,
                    host: db.host,
                    port: db.port,
                    username: db.username,
                    password: db.password,
                    ssl: db.ssl,
                    url: db.url
                })
            )
        )
        .digest('hex')
}

/** Malformed, missing or ambiguous host input grants nothing. No user/email/organization fallback. */
export function operatorDesignation(env: Env): { userId: string; database: string } | null {
    try {
        const value = JSON.parse(env[INSTANCE_OPERATOR_KEY] ?? '')
        if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'database,userId') return null
        if (typeof value.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.userId)) return null
        if (typeof value.database !== 'string' || !/^[a-f0-9]{64}$/.test(value.database)) return null
        return { userId: value.userId, database: value.database }
    } catch {
        return null
    }
}

export async function isInstanceOperator(req: Request, env: Env = process.env): Promise<boolean> {
    if (!(req as Request & { cuttlelyIdentity?: boolean }).cuttlelyIdentity || req.user?.apiKeyId) return false
    const designation = operatorDesignation(env)
    if (!designation || designation.userId !== req.user?.id) return false
    const { getDataSource } = await import('../DataSource')
    if (operatorDatabaseFingerprint(getDataSource().options) !== designation.database) return false
    // Re-read active tenant/user status too. Designation never changes tenant ownership or permissions.
    return (await resolveTeamAccess(designation.userId, req.user?.activeWorkspaceId ?? '')).owner
}

export function requireInstanceOperator(env: () => Env = () => process.env): RequestHandler {
    return (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store')
        void isInstanceOperator(req, env())
            .then((allowed) => {
                if (allowed) next()
                else res.status(403).json({ code: 'INSTANCE_OPERATOR_REQUIRED', message: INSTANCE_OPERATOR_NOTICE })
            })
            .catch(() => {
                if (!res.headersSent) res.status(403).json({ code: 'INSTANCE_OPERATOR_REQUIRED', message: INSTANCE_OPERATOR_NOTICE })
            })
    }
}
