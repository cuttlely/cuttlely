// Imported test stamps were signed for another server. Keep the saved query and drop the stamp.

const STAMP_FIELDS = ['testedStamp', 'testedAt', 'testedBy', 'testedColumns', 'columnsChanged'] as const

export interface SavedQuery {
    id?: string
    name?: string
    purpose?: string
    description?: string
    sql?: string
    params?: unknown
    version?: number
    rowCap?: number
    needsRetest?: boolean
    importedVerification?: string
    testedStamp?: string
    testedAt?: string
    testedBy?: string
    testedColumns?: unknown
    columnsChanged?: boolean
    [key: string]: unknown
}

export function readQueries(value: unknown): SavedQuery[] {
    let parsed = value
    if (typeof value === 'string') {
        const text = value.trim()
        if (!text) return []
        try {
            parsed = JSON.parse(text)
        } catch {
            return []
        }
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item === 'object') as SavedQuery[]
}

export function writeQueries(list: SavedQuery[]): string {
    return JSON.stringify(list)
}

export function queryReady(pin: SavedQuery | null | undefined): boolean {
    if (!pin || typeof pin.testedStamp !== 'string' || !pin.testedStamp.trim()) return false
    if (pin.needsRetest || pin.columnsChanged) return false
    if (pin.importedVerification === 'untrusted') return false
    return true
}

export function untrustQuery(pin: SavedQuery): SavedQuery {
    const next: SavedQuery = { ...pin, needsRetest: true, importedVerification: 'untrusted' }
    for (const field of STAMP_FIELDS) delete next[field]
    return next
}

function walkNodes(flow: { nodes?: unknown }): Array<{ node: Record<string, unknown>; inputs: Record<string, unknown> }> {
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
    const found = []
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const data = (node as { data?: unknown }).data
        if (!data || typeof data !== 'object') continue
        const inputs = (data as { inputs?: unknown }).inputs
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue
        found.push({ node: node as Record<string, unknown>, inputs: inputs as Record<string, unknown> })
    }
    return found
}

export const IMPORT_HOLD = 'unverified'

export function flowHasUntrustedImport(value: unknown): boolean {
    const flow = parseFlow(value)
    if (!flow) return false
    if ((flow as { importVerification?: unknown }).importVerification === IMPORT_HOLD) return true
    return queriesOnFlow(flow).some((item) => item.pin.importedVerification === 'untrusted')
}

export function clearImportHold<T>(flow: T): T {
    if (!flow || typeof flow !== 'object') return flow
    const copy = { ...(flow as object) } as T & { importVerification?: string }
    delete copy.importVerification
    return copy
}

export function parseFlow(value: unknown): { nodes: unknown[]; edges: unknown[]; [key: string]: unknown } | null {
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        } catch {
            return null
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const flow = parsed as { nodes?: unknown; edges?: unknown }
    if (!Array.isArray(flow.nodes)) return null
    return { ...(parsed as object), nodes: flow.nodes, edges: Array.isArray(flow.edges) ? flow.edges : [] } as {
        nodes: unknown[]
        edges: unknown[]
    }
}

// Drop destination-untrusted stamps. `keep` names queries this server already retested in the current run.
export function untrustImportedFlow(flow: { nodes?: unknown }, keep: Set<string> = new Set()): { flow: typeof flow; stripped: number } {
    const copy = structuredClone(flow) as { nodes?: unknown; importVerification?: string }
    copy.importVerification = IMPORT_HOLD
    let stripped = 0
    for (const { node, inputs } of walkNodes(copy)) {
        if (!Object.prototype.hasOwnProperty.call(inputs, 'pinnedQueries')) continue
        const nodeId = String(node.id || (node.data as { id?: string } | undefined)?.id || '')
        const next = readQueries(inputs.pinnedQueries).map((pin) => {
            const key = `${nodeId}\0${String(pin.id || '')}`
            if (keep.has(key) && pin.verifiedHere === true && queryReady(pin)) return pin
            if (!pin.testedStamp && pin.importedVerification === 'untrusted' && pin.needsRetest) return pin
            if (pin.testedStamp || pin.testedAt || pin.testedColumns || pin.importedVerification !== 'untrusted') stripped += 1
            return untrustQuery(pin)
        })
        inputs.pinnedQueries = writeQueries(next)
    }
    return { flow: copy, stripped }
}

export function queriesOnFlow(flow: { nodes?: unknown }): Array<{ nodeId: string; nodeLabel: string; pin: SavedQuery }> {
    const found = []
    for (const { node, inputs } of walkNodes(flow)) {
        const data = node.data as { id?: string; label?: string; name?: string }
        const nodeId = String(node.id || data?.id || '')
        const nodeLabel = String(data?.label || data?.name || nodeId)
        for (const pin of readQueries(inputs.pinnedQueries)) {
            found.push({ nodeId, nodeLabel, pin })
        }
    }
    return found
}

export function replaceQuery(flow: { nodes?: unknown }, nodeId: string, entry: SavedQuery): { nodes?: unknown } {
    const copy = structuredClone(flow) as { nodes?: unknown }
    for (const { node, inputs } of walkNodes(copy)) {
        const id = String(node.id || (node.data as { id?: string } | undefined)?.id || '')
        if (id !== nodeId) continue
        const list = readQueries(inputs.pinnedQueries)
        const index = list.findIndex((pin) => pin.id === entry.id)
        const stored = { ...entry }
        delete stored.importedVerification
        if (index >= 0) list[index] = stored
        else list.push(stored)
        inputs.pinnedQueries = writeQueries(list)
    }
    return copy
}
