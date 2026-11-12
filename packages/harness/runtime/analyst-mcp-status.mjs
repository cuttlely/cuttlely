// What the specialist MCP bridges have recorded about analyst tools.
// Every specialist bridge shares this one file. tools is the number of query
// and pinned query tools (pq_...) a list offered. 0 means no such tool has
// been recorded yet: the gateway was down, the list failed, or it had none.
// A later empty, failed, or non-analyst list must not replace a count above 0.
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from '../paths.mjs'

export const ANALYST_MCP_STATUS_NAME = 'analyst-mcp.json'

// query, or a pinned query (pq_ plus at least one letter, digit, or underscore),
// either as the whole name or after __. describe and other tools do not count.
// A scan, not a regex: /(?:^|__)(?:query|pq_[a-z0-9_]+)$/ backtracks on a name
// that starts with pq_ and repeats __pq_.
const STATUS_LOCK_WAIT_MS = 2000
const STATUS_LOCK_STALE_MS = 5000

// Hermes starts the bridge without the server's environment. The profile env
// passes CUTTLELY_DATA_DIR. When that is missing too, use the same directory
// the start script and dataRoot() use.
export function analystDataDir(dataDir) {
    const explicit = dataDir == null ? '' : String(dataDir).trim()
    if (explicit) return explicit
    return dataRoot()
}

export function analystMcpStatusPath(dataDir) {
    return path.join(analystDataDir(dataDir), ANALYST_MCP_STATUS_NAME)
}

export function writeAnalystMcpStatus(tools, dataDir) {
    const dir = analystDataDir(dataDir)
    const count = Number(tools)
    const body = { tools: Number.isFinite(count) && count > 0 ? count : 0 }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(analystMcpStatusPath(dir), `${JSON.stringify(body)}\n`)
    return body
}

export function readAnalystMcpStatus(dataDir) {
    const dir = analystDataDir(dataDir)
    try {
        const body = JSON.parse(fs.readFileSync(analystMcpStatusPath(dir), 'utf8'))
        if (!body || typeof body.tools !== 'number') return null
        return body
    } catch {
        return null
    }
}

function isOfferChar(code) {
    return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code === 95
}

function isPinnedOffer(name, at, cleanFrom) {
    if (at < cleanFrom || at + 4 > name.length) return false
    return name.startsWith('pq_', at)
}

export function isAnalystOfferName(name) {
    if (name === 'query' || name.endsWith('__query')) return true
    let cleanFrom = name.length
    for (let i = name.length - 1; i >= 0; i -= 1) {
        if (!isOfferChar(name.charCodeAt(i))) break
        cleanFrom = i
    }
    if (isPinnedOffer(name, 0, cleanFrom)) return true
    for (let i = 0; i + 1 < name.length; i += 1) {
        if (name.charCodeAt(i) === 95 && name.charCodeAt(i + 1) === 95 && isPinnedOffer(name, i + 2, cleanFrom)) return true
    }
    return false
}

export function analystOfferCount(tools) {
    if (!Array.isArray(tools)) return 0
    let count = 0
    for (const tool of tools) {
        let raw = ''
        if (typeof tool === 'string') raw = tool
        else if (tool && typeof tool === 'object' && typeof tool.name === 'string') raw = tool.name
        const name = raw.trim().toLowerCase()
        if (isAnalystOfferName(name)) count += 1
    }
    return count
}

function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Exclusive create so two bridges cannot both decide the file is still 0 and
// have the empty list land last. A crashed writer leaves a lock; it is stolen
// once it is old. Null means the lock was not acquired.
function withStatusLock(dir, fn) {
    fs.mkdirSync(dir, { recursive: true })
    const lockPath = path.join(dir, `${ANALYST_MCP_STATUS_NAME}.lock`)
    const started = Date.now()
    // The lock loop runs until this process creates the lock or gives up.
    // eslint-disable-next-line no-constant-condition
    for (;;) {
        let fd
        try {
            fd = fs.openSync(lockPath, 'wx')
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error
            let age = 0
            try {
                age = Date.now() - fs.statSync(lockPath).mtimeMs
            } catch {
                continue
            }
            if (age >= STATUS_LOCK_STALE_MS) {
                try {
                    fs.rmSync(lockPath, { force: true })
                } catch {
                    // The holder removed it.
                }
                continue
            }
            if (Date.now() - started >= STATUS_LOCK_WAIT_MS) return null
            sleepMs(5)
            continue
        }
        try {
            return fn()
        } finally {
            fs.closeSync(fd)
            try {
                fs.rmSync(lockPath, { force: true })
            } catch {
                // Already gone.
            }
        }
    }
}

// Record one tools/list. A count of 0 does not replace a query or pinned offer
// that is already on disk. writeAnalystMcpStatus still stores the number it is given.
export function noteAnalystToolCount(tools, dataDir) {
    const next = analystOfferCount(tools)
    const dir = analystDataDir(dataDir)
    const noted = withStatusLock(dir, () => {
        if (next === 0) {
            const current = readAnalystMcpStatus(dir)
            if (current && current.tools > 0) return current
        }
        return writeAnalystMcpStatus(next, dir)
    })
    if (noted) return noted
    if (next === 0) return readAnalystMcpStatus(dir) || { tools: 0 }
    return writeAnalystMcpStatus(next, dir)
}

export function analystToolsMissing(dataDir) {
    const status = readAnalystMcpStatus(dataDir)
    return Boolean(status && status.tools === 0)
}

export function analystPingHeader(dataDir) {
    const status = readAnalystMcpStatus(dataDir)
    if (!status) return 'unknown'
    return status.tools === 0 ? 'missing' : 'ready'
}
