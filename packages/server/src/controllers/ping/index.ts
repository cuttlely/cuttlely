import fs from 'fs'
import path from 'path'
import { Request, Response, NextFunction } from 'express'
import { getDatabaseHealth } from '../../startup/databaseHealth'

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
    try {
        const body = JSON.parse(fs.readFileSync(path.join(dataDir, 'hermes-supervisor.json'), 'utf8'))
        if (body?.state === 'down') return { code: 503, body: 'hermes down', header: 'down', analyst }
        if (body?.state === 'restarting') return { code: 200, body: 'pong', header: 'restarting', analyst }
        if (body?.state === 'degraded') return { code: 200, body: 'pong', header: 'degraded', analyst }
        if (body?.state === 'up') return { code: 200, body: 'pong', header: 'up', analyst }
    } catch {
        // No supervisor file means Hermes was not started by scripts/start-cuttlely.sh.
    }
    return { code: 200, body: 'pong', header: 'unknown', analyst }
}

const getPing = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const health = pingForDataDir(process.env.CUTTLELY_DATA_DIR)
        res.setHeader('X-Cuttlely-Hermes', health.header)
        res.setHeader('X-Cuttlely-Analyst', health.analyst)
        // The database comes first: without it nothing works, so Docker and Render must see the server as unhealthy.
        const database = getDatabaseHealth()
        const db = database ? await database.check() : null
        res.setHeader('X-Cuttlely-Database', db ? (db.ok ? 'up' : 'down') : 'unknown')
        if (db && !db.ok) return res.status(503).send(`database unreachable: ${db.reason}`)
        return res.status(health.code).send(health.body)
    } catch (error) {
        next(error)
    }
}

export default {
    getPing
}
