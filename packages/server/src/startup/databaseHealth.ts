/**
 * Whether the server can reach its own database, for the health check (/api/v1/ping) and the boot log.
 *
 * Docker's HEALTHCHECK, the Compose files and Render's healthCheckPath all use /api/v1/ping. It answers 503 while the
 * boot profile compile is still the startup gate, and while the database cannot be reached, at startup or later, so a
 * container shows unhealthy and Render keeps a new deploy from going live and restarts an instance that lost its database. A start that never opened the database can only recover
 * by starting again, so a restart is the right answer there; a later outage clears by itself once the database
 * answers, because the connection pool reconnects. The check is one SELECT 1, cached for a few seconds.
 *
 * The log names the host and port (or the SQLite file), never the user or password.
 */

export type DatabaseProbe = () => Promise<void>
export type HealthLog = { error: (line: string) => void; info: (line: string) => void }
export type DatabaseState = { ok: true } | { ok: false; reason: string }

const PLAIN_REASONS: Record<string, string> = {
    ECONNREFUSED: 'connection refused',
    ETIMEDOUT: 'timed out',
    ENOTFOUND: 'host not found',
    EAI_AGAIN: 'host not found',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
    ECONNRESET: 'connection reset',
    '28P01': 'sign-in refused',
    '28000': 'sign-in refused',
    '3D000': 'database does not exist',
    SQLITE_CANTOPEN: 'the file cannot be opened',
    SQLITE_BUSY: 'the file is locked',
    NOT_CONNECTED: 'not connected'
}

/** Where the database is, for the log: host:port, or the SQLite file. Never the user or password. */
export function databaseWhere(env: NodeJS.ProcessEnv = process.env, sqliteFile?: string): string {
    const type = (env.DATABASE_TYPE || 'sqlite').toLowerCase()
    if (type === 'sqlite') return `the SQLite file ${sqliteFile ?? 'database.sqlite'}`
    const port = env.DATABASE_PORT || (type === 'postgres' ? '5432' : '3306')
    return `${type} at ${env.DATABASE_HOST || 'localhost'}:${port}`
}

/** A short plain reason from a driver error. Unknown errors say so rather than echo a message that might carry values. */
export function plainReason(error: unknown): string {
    const err = error as { code?: unknown; errno?: unknown; errors?: unknown[] } | undefined
    const codes = [err?.code, ...(Array.isArray(err?.errors) ? err!.errors.map((e) => (e as { code?: unknown })?.code) : [])]
    for (const code of codes) {
        if (typeof code === 'string' && PLAIN_REASONS[code]) return PLAIN_REASONS[code]
    }
    const first = codes.find((code) => typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code as string))
    return typeof first === 'string' ? first : 'no answer'
}

export function unreachableLine(where: string, reason: string): string {
    return `🗄️ [server]: Cuttlely can't reach its database (${where}): ${reason}. It is not ready: the health check answers 503 until the database answers.`
}

export function backLine(where: string): string {
    return `🗄️ [server]: The database answers again (${where}). Cuttlely is ready.`
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), ms)
        timer.unref?.()
        work.then(
            () => {
                clearTimeout(timer)
                resolve()
            },
            (error) => {
                clearTimeout(timer)
                reject(error)
            }
        )
    })
}

export class DatabaseHealth {
    private state: DatabaseState = { ok: true }
    private checkedAt = -Infinity
    private running: Promise<DatabaseState> | null = null
    private logged: 'up' | 'down' = 'up'

    constructor(
        private probe: DatabaseProbe,
        private where: () => string,
        private log: HealthLog,
        private opts: { cacheMs?: number; timeoutMs?: number; now?: () => number } = {}
    ) {}

    /** The start could not open the database: log it once and answer 503 from now on until a check passes. */
    markDown(error: unknown): void {
        this.set({ ok: false, reason: plainReason(error) })
        this.checkedAt = this.now()
    }

    current(): DatabaseState {
        return this.state
    }

    async check(): Promise<DatabaseState> {
        if (this.now() - this.checkedAt < (this.opts.cacheMs ?? 5000)) return this.state
        if (!this.running) {
            this.running = withTimeout(this.probe(), this.opts.timeoutMs ?? 3000)
                .then(() => ({ ok: true } as DatabaseState))
                .catch((error) => ({ ok: false, reason: plainReason(error) } as DatabaseState))
                .then((next) => {
                    this.set(next)
                    this.checkedAt = this.now()
                    this.running = null
                    return next
                })
        }
        return this.running
    }

    private set(next: DatabaseState): void {
        this.state = next
        if (!next.ok && this.logged === 'up') {
            this.logged = 'down'
            this.log.error(unreachableLine(this.where(), next.reason))
        } else if (next.ok && this.logged === 'down') {
            this.logged = 'up'
            this.log.info(backLine(this.where()))
        }
    }

    private now(): number {
        return (this.opts.now ?? Date.now)()
    }
}

let shared: DatabaseHealth | null = null

/** The server's one instance. Set at boot (index.ts); ping falls back to "unknown" (ok) when it was never set. */
export function setDatabaseHealth(next: DatabaseHealth | null): void {
    shared = next
}

export function getDatabaseHealth(): DatabaseHealth | null {
    return shared
}
