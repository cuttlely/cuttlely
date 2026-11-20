import fs from 'fs'
import path from 'path'
import { Request, Response, NextFunction } from 'express'
import { getDatabaseHealth } from '../../startup/databaseHealth'
import { BOOT_RETRY_AFTER_SECONDS, bootPassBlocksPing, PROFILES_COMPILING } from '../../services/harnesses/bootGate'
import { runtimeState } from '../../utils/runtimeAvailability'

function analystHeader(dataDir: string | undefined): string {
    if (!dataDir) return 'unknown'
    try {
        const body = JSON.parse(fs.readFileSync(path.join(dataDir, 'analyst-mcp.json'), 'utf8'))
        if (typeof body?.tools !== 'number') return 'unknown'
        return body.tools === 0 ? 'missing' : 'ready'
    } catch {
        return 'unknown'
    }
}

export function pingForDataDir(dataDir: string | undefined): { code: number; body: string; header: string; analyst: string } {
    const analyst = analystHeader(dataDir)
    if (!dataDir) return { code: 200, body: 'pong', header: 'unknown', analyst }
    const header = runtimeState(dataDir)
    return ['down', 'cooldown', 'exhausted'].includes(header)
        ? { code: 503, body: 'hermes down', header, analyst }
        : { code: 200, body: 'pong', header, analyst }
}

// Strict runtime readiness. 503 until the boot profile compile finishes (or if that pass did not finish), then the
// usual answer: 200 once the compile is done, including when it continues in the background past the startup cap.
export function composePing(dataDir: string | undefined): {
    code: number
    body: string
    header: string
    analyst: string
    retryAfter?: number
} {
    if (bootPassBlocksPing()) {
        return { code: 503, body: PROFILES_COMPILING, header: 'compiling', analyst: 'unknown', retryAfter: BOOT_RETRY_AFTER_SECONDS }
    }
    return pingForDataDir(dataDir)
}

const healthHandler = (live: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        const health = composePing(process.env.CUTTLELY_DATA_DIR)
        res.setHeader('X-Cuttlely-Hermes', health.header)
        res.setHeader('X-Cuttlely-Analyst', health.analyst)
        if (health.retryAfter) res.setHeader('Retry-After', String(health.retryAfter))
        if (bootPassBlocksPing()) return res.status(health.code).send(health.body)
        // The database comes first: without it nothing works, so Docker and Render must see the server as unhealthy.
        const database = getDatabaseHealth()
        const db = database ? await database.check() : null
        res.setHeader('X-Cuttlely-Database', db ? (db.ok ? 'up' : 'down') : 'unknown')
        if (db && !db.ok) return res.status(503).send(`database unreachable: ${db.reason}`)
        // The startup page also returns 503 during initial boot. A gateway must wait until Node can serve the app.
        return live ? res.status(200).send('pong') : res.status(health.code).send(health.body)
    } catch (error) {
        next(error)
    }
}

const getPing = healthHandler(false)
const getLive = healthHandler(true)

export default {
    getPing,
    getLive
}
