// What Hermes last received from the analyst MCP bridge.
// tools: 0 means the gateway was down or the server listed nothing.
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from '../paths.mjs'

export const ANALYST_MCP_STATUS_NAME = 'analyst-mcp.json'

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

export function analystToolsMissing(dataDir) {
    const status = readAnalystMcpStatus(dataDir)
    return Boolean(status && status.tools === 0)
}

export function analystPingHeader(dataDir) {
    const status = readAnalystMcpStatus(dataDir)
    if (!status) return 'unknown'
    return status.tools === 0 ? 'missing' : 'ready'
}
