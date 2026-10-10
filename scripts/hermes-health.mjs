// Supervisor status for the Hermes process started by scripts/start-cuttlely.sh.
// Cuttlely stays up if Hermes dies. Ping reads this file and says so after the restart limit.
import fs from 'node:fs'
import path from 'node:path'

export const HERMES_STATUS_NAME = 'hermes-supervisor.json'

export function hermesStatusPath(dataDir) {
    return path.join(dataDir, HERMES_STATUS_NAME)
}

export function writeHermesStatus(dataDir, { state, restarts = 0, pid = 0, detail = '' } = {}) {
    const dir = String(dataDir || '')
    if (!dir) throw new Error('CUTTLELY_DATA_DIR is required')
    fs.mkdirSync(dir, { recursive: true })
    const body = {
        state: String(state || 'up'),
        restarts: Number(restarts) || 0,
        pid: Number(pid) || 0,
        detail: String(detail || '').replace(/["\\\n\r]/g, ' ')
    }
    fs.writeFileSync(hermesStatusPath(dir), `${JSON.stringify(body)}\n`)
    return body
}

export function readHermesStatus(dataDir) {
    if (!dataDir) return null
    try {
        const body = JSON.parse(fs.readFileSync(hermesStatusPath(dataDir), 'utf8'))
        if (!body || typeof body.state !== 'string') return null
        return body
    } catch {
        return null
    }
}

export function pingForHermesStatus(status) {
    if (status?.state === 'down') return { code: 503, body: 'hermes down', header: 'down' }
    if (status?.state === 'restarting') return { code: 200, body: 'pong', header: 'restarting' }
    if (status?.state === 'degraded') return { code: 200, body: 'pong', header: 'degraded' }
    if (status?.state === 'up') return { code: 200, body: 'pong', header: 'up' }
    return { code: 200, body: 'pong', header: 'unknown' }
}

function cli() {
    const command = process.argv[2]
    if (command !== 'write') return
    const dataDir = process.env.CUTTLELY_DATA_DIR
    writeHermesStatus(dataDir, {
        state: process.argv[3],
        restarts: process.argv[4],
        detail: process.argv[5] || '',
        pid: process.argv[6] || 0
    })
}

if (process.argv[1] && process.argv[1].endsWith('hermes-health.mjs')) cli()
