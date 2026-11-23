// Supervisor status for the Hermes process started by scripts/start-cuttlely.sh.
// Ping and agent admission read the state; exhausted recovery defaults to a process restart.
import fs from 'node:fs'
import path from 'node:path'

export const HERMES_STATUS_NAME = 'hermes-supervisor.json'

export function hermesStatusPath(dataDir) {
    return path.join(dataDir, HERMES_STATUS_NAME)
}

export function writeHermesStatus(
    dataDir,
    {
        state,
        restarts = 0,
        pid = 0,
        detail = '',
        lifetimeRestarts = restarts,
        burstCount = restarts,
        burstBudget = 5,
        action = 'cooldown'
    } = {}
) {
    const dir = String(dataDir || '')
    if (!dir) throw new Error('CUTTLELY_DATA_DIR is required')
    fs.mkdirSync(dir, { recursive: true })
    const body = {
        state: String(state || 'up'),
        restarts: Number(restarts) || 0,
        lifetimeRestarts: Number(lifetimeRestarts) || 0,
        burstCount: Number(burstCount) || 0,
        burstBudget: Number(burstBudget) || 0,
        action: ['exit', 'cooldown'].includes(action) ? action : 'cooldown',
        pid: Number(pid) || 0,
        detail: String(detail || '').replace(/["\\\n\r]/g, ' ')
    }
    const temporary = `${hermesStatusPath(dir)}.${process.pid}.tmp`
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(body)}\n`)
        fs.renameSync(temporary, hermesStatusPath(dir))
    } finally {
        fs.rmSync(temporary, { force: true })
    }
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
    if (['down', 'exhausted', 'cooldown'].includes(status?.state)) return { code: 503, body: 'hermes down', header: 'down' }
    if (status?.state === 'restarting') return { code: 200, body: 'pong; hermes restarting', header: 'restarting' }
    if (status?.state === 'degraded') return { code: 200, body: 'pong; hermes degraded', header: 'degraded' }
    if (status?.state === 'up') return { code: 200, body: 'pong', header: 'up' }
    return { code: 200, body: 'pong', header: 'unknown' }
}

function cli() {
    const command = process.argv[2]
    if (command === 'lifetime') {
        // eslint-disable-next-line no-console
        console.log(Number(readHermesStatus(process.env.CUTTLELY_DATA_DIR)?.lifetimeRestarts) || 0)
        return
    }
    if (command !== 'write') return
    const dataDir = process.env.CUTTLELY_DATA_DIR
    writeHermesStatus(dataDir, {
        state: process.argv[3],
        restarts: process.argv[4],
        detail: process.argv[5] || '',
        pid: process.argv[6] || 0,
        lifetimeRestarts: process.argv[7] || process.argv[4],
        burstBudget: process.argv[8] ?? 5,
        action: process.argv[9] || 'cooldown'
    })
}

if (process.argv[1] && process.argv[1].endsWith('hermes-health.mjs')) cli()
