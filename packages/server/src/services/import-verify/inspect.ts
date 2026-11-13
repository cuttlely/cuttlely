// Structural checks for an imported flow. These do not call a model or a database.

import { readQueries } from './stamps'
import { type ConnectionResolution } from './connections'

export interface InspectInput {
    flow: { nodes?: unknown; edges?: unknown }
    loadedNodeNames?: string[]
    pinnedQueriesEnabled: boolean
    pdfAvailable?: boolean
    resolutions: ConnectionResolution[]
    statementHashes?: Record<string, string>
}

export interface Blocker {
    id: string
    severity: 'attention' | 'incomplete'
    message: string
    action: 'choose-connection' | 'retry' | 'turn-on-saved-queries' | 'install-dependency' | 'review-contract' | 'none'
    slotId?: string
    nodeId?: string
    pinId?: string
}

export interface SmokeNeed {
    id: 'report' | 'analysis' | 'csv' | 'pdf'
    label: string
    pinNames: string[]
    needsRows: boolean
}

interface Contract {
    pin?: string
    hash?: string
    statementHash?: string
    mode?: string
    emptyText?: string
}

function nodeData(node: unknown): Record<string, unknown> | null {
    if (!node || typeof node !== 'object') return null
    const data = (node as { data?: unknown }).data
    if (!data || typeof data !== 'object') return null
    return data as Record<string, unknown>
}

function contractsOf(inputs: Record<string, unknown>): Contract[] {
    const raw = inputs.trustedOutputs
    let parsed = raw
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw)
        } catch {
            return [{ mode: 'invalid' }]
        }
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item === 'object') as Contract[]
}

// A contract sits on the specialist. The saved query sits on a Postgres card wired into that specialist.
function pinsForContracts(
    flow: { nodes?: unknown; edges?: unknown },
    nodeId: string
): Array<{ nodeId: string; pin: ReturnType<typeof readQueries>[number] }> {
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
    const edges = Array.isArray(flow.edges) ? flow.edges : []
    const byId = new Map(nodes.map((node) => [String((node as { id?: string })?.id || ''), node]))
    const found: Array<{ nodeId: string; pin: ReturnType<typeof readQueries>[number] }> = []
    const add = (id: string, node: unknown) => {
        const data = nodeData(node)
        const inputs = data?.inputs && typeof data.inputs === 'object' ? (data.inputs as Record<string, unknown>) : {}
        for (const pin of readQueries(inputs.pinnedQueries)) found.push({ nodeId: id, pin })
    }
    add(nodeId, byId.get(nodeId))
    for (const edge of edges) {
        if (!edge || typeof edge !== 'object') continue
        if (String((edge as { target?: string }).target || '') !== nodeId) continue
        const sourceId = String((edge as { source?: string }).source || '')
        if (sourceId) add(sourceId, byId.get(sourceId))
    }
    return found
}

function usesPdf(inputs: Record<string, unknown>): boolean {
    const preset = String(inputs.preset || '').toLowerCase()
    if (preset === 'assets') return true
    const text = `${inputs.specialistPrompt || ''} ${inputs.systemMessage || ''} ${inputs.instructions || ''}`
    return /pdf_report|\.pdf\b/i.test(text)
}

export function inspectFlow(input: InspectInput): { blockers: Blocker[]; smoke: SmokeNeed[] } {
    const blockers: Blocker[] = []
    const smoke: SmokeNeed[] = []
    const nodes = Array.isArray(input.flow.nodes) ? input.flow.nodes : []
    const edges = Array.isArray(input.flow.edges) ? input.flow.edges : []
    const ids = new Set(nodes.map((node) => String((node as { id?: string })?.id || '')))
    const loaded = input.loadedNodeNames ? new Set(input.loadedNodeNames) : null
    const byResolution = new Map(input.resolutions.map((item) => [item.slot.id, item]))

    for (const edge of edges) {
        if (!edge || typeof edge !== 'object') continue
        const source = String((edge as { source?: string }).source || '')
        const target = String((edge as { target?: string }).target || '')
        if ((source && !ids.has(source)) || (target && !ids.has(target))) {
            blockers.push({
                id: `edge:${source}:${target}`,
                severity: 'attention',
                message: 'A connection points at a card that is not in this flow.',
                action: 'none'
            })
        }
    }

    let sawQueries = false
    const reportPins: string[] = []
    const csvPins: string[] = []
    let pdf = false
    for (const node of nodes) {
        const data = nodeData(node)
        if (!data) continue
        const nodeId = String((node as { id?: string }).id || data.id || '')
        const label = String(data.label || data.name || 'A card')
        const name = String(data.name || '')
        if (!name) {
            blockers.push({
                id: `node:${nodeId}:name`,
                severity: 'attention',
                message: `${label} has no tool name, so it cannot be checked.`,
                action: 'none',
                nodeId
            })
        } else if (loaded && !loaded.has(name)) {
            blockers.push({
                id: `node:${nodeId}:missing`,
                severity: 'attention',
                message: `${label} uses ${name}, and that tool is not available on this server.`,
                action: 'none',
                nodeId
            })
        }
        const inputs = data.inputs && typeof data.inputs === 'object' ? (data.inputs as Record<string, unknown>) : {}
        const queries = readQueries(inputs.pinnedQueries)
        if (queries.length) sawQueries = true
        const slot = byResolution.get(`${nodeId}:credential`)
        const category = String(data.category || '')
        const modelLike = category === 'Chat Models' || category === 'Embeddings' || category === 'Chat Model'
        if (
            slot &&
            slot.status !== 'reused' &&
            slot.status !== 'matched' &&
            slot.status !== 'empty' &&
            (queries.length || modelLike || slot.slot.needed)
        ) {
            blockers.push({
                id: `connection:${slot.slot.id}`,
                severity: 'attention',
                message:
                    slot.status === 'ambiguous'
                        ? `${label} matches more than one saved connection. Choose the one that belongs to this flow.`
                        : `${label} needs a connection on this server. Choose one to continue.`,
                action: 'choose-connection',
                slotId: slot.slot.id,
                nodeId
            })
        }
        if (modelLike && slot && slot.status === 'empty' && slot.slot.required) {
            blockers.push({
                id: `connection:${slot.slot.id}:empty`,
                severity: 'attention',
                message: `${label} has no connection. Choose the credential it should use.`,
                action: 'choose-connection',
                slotId: slot.slot.id,
                nodeId
            })
        }
        if (usesPdf(inputs)) pdf = true
        const contracts = contractsOf(inputs)
        if (contracts.some((item) => item.mode === 'invalid')) {
            blockers.push({
                id: `contract:${nodeId}:json`,
                severity: 'attention',
                message: `${label} has a verified-output contract that could not be read.`,
                action: 'review-contract',
                nodeId
            })
        }
        for (const contract of contracts) {
            if (!contract.pin) continue
            const provided = pinsForContracts(input.flow, nodeId).find((item) => item.pin.name === contract.pin)
            if (!provided) {
                blockers.push({
                    id: `contract:${nodeId}:${contract.pin}`,
                    severity: 'attention',
                    message: `${label} expects saved query ${contract.pin}, and that query is not on a card connected to it.`,
                    action: 'review-contract',
                    nodeId
                })
                continue
            }
            const fresh = input.statementHashes?.[`${provided.nodeId}\0${String(provided.pin.id || '')}`]
            const expected = String(contract.hash || contract.statementHash || '')
            if (fresh && expected && fresh !== expected) {
                blockers.push({
                    id: `contract:${nodeId}:${contract.pin}:hash`,
                    severity: 'attention',
                    message: `The output contract for ${contract.pin} does not match the query that was just tested. Review the contract before publishing.`,
                    action: 'review-contract',
                    nodeId: provided.nodeId,
                    pinId: String(provided.pin.id || '')
                })
            }
            if (contract.mode === 'table-payload-csv') csvPins.push(String(contract.pin))
            else if (contract.mode && contract.mode !== 'invalid') reportPins.push(String(contract.pin))
        }
    }

    if (sawQueries && !input.pinnedQueriesEnabled) {
        blockers.push({
            id: 'feature:pinned',
            severity: 'incomplete',
            message: 'Saved queries are turned off on this server, so they could not be tested. Turn them on, then resume.',
            action: 'turn-on-saved-queries'
        })
    }
    if (pdf && input.pdfAvailable === false) {
        blockers.push({
            id: 'feature:pdf',
            severity: 'attention',
            message: 'This flow builds PDF reports, and the PDF library is not available on this server.',
            action: 'install-dependency'
        })
    }

    if (sawQueries) smoke.push({ id: 'analysis', label: 'Analysis', pinNames: [], needsRows: false })
    if (reportPins.length) smoke.push({ id: 'report', label: 'Report', pinNames: reportPins, needsRows: true })
    if (csvPins.length) smoke.push({ id: 'csv', label: 'CSV', pinNames: csvPins, needsRows: true })
    if (pdf) smoke.push({ id: 'pdf', label: 'PDF', pinNames: [], needsRows: false })
    return { blockers, smoke }
}

export function nodeById(flow: { nodes?: unknown }, nodeId: string): Record<string, unknown> | null {
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const id = String((node as { id?: string }).id || '')
        if (id === nodeId) return node as Record<string, unknown>
    }
    return null
}

export function relationsOf(node: Record<string, unknown> | null): string[] {
    const data = node ? nodeData(node) : null
    const inputs = data?.inputs && typeof data.inputs === 'object' ? (data.inputs as Record<string, unknown>) : {}
    const raw = inputs.analystRelations
    if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean)
    if (typeof raw !== 'string') return []
    const text = raw.trim()
    if (!text) return []
    try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean)
    } catch {
        // A comma-separated table list is the other saved form.
    }
    return text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
}
