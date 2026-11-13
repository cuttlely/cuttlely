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

export interface SmokePin {
    nodeId: string
    pinId: string
    name: string
}

export interface SmokeNeed {
    id: 'report' | 'analysis' | 'csv' | 'pdf'
    label: string
    pins: SmokePin[]
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
    const reportPins: SmokePin[] = []
    const csvPins: SmokePin[] = []
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
        if (slot && slot.status !== 'reused' && slot.status !== 'matched' && slot.status !== 'empty' && slot.slot.needed) {
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
        if (slot && slot.status === 'empty' && slot.slot.required && slot.slot.needed) {
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
            if (contract.mode === 'invalid') continue
            const pinName = typeof contract.pin === 'string' ? contract.pin.trim() : ''
            if (!pinName) {
                blockers.push({
                    id: `contract:${nodeId}:unnamed`,
                    severity: 'attention',
                    message: `${label} has a verified-output contract that does not name a saved query. Review the contract before publishing.`,
                    action: 'review-contract',
                    nodeId
                })
                continue
            }
            contract.pin = pinName
            const matches = pinsForContracts(input.flow, nodeId).filter((item) => item.pin.name === contract.pin)
            if (matches.length !== 1) {
                blockers.push({
                    id: `contract:${nodeId}:${contract.pin}${matches.length ? ':ambiguous' : ''}`,
                    severity: 'attention',
                    message:
                        matches.length > 1
                            ? `${label} has more than one connected saved query named ${contract.pin}. A report has to use one of them.`
                            : `${label} expects saved query ${contract.pin}, and that query is not on a card connected to it.`,
                    action: 'review-contract',
                    nodeId
                })
                continue
            }
            const provided = matches[0]
            const fresh = input.statementHashes?.[`${provided.nodeId}\0${String(provided.pin.id || '')}`] || ''
            const expected = String(contract.hash || contract.statementHash || '').trim()
            if (!expected || !fresh || fresh !== expected) {
                blockers.push({
                    id: `contract:${nodeId}:${contract.pin}:hash`,
                    severity: 'attention',
                    message: expected
                        ? `The output contract for ${contract.pin} does not match the query that was just tested. Review the contract before publishing.`
                        : `The output contract for ${contract.pin} has no tested statement hash, so row count alone is not proof. Review the contract before publishing.`,
                    action: 'review-contract',
                    nodeId: provided.nodeId,
                    pinId: String(provided.pin.id || '')
                })
                continue
            }
            const smokePin = {
                nodeId: provided.nodeId,
                pinId: String(provided.pin.id || ''),
                name: String(provided.pin.name || contract.pin)
            }
            if (contract.mode === 'table-payload-csv') csvPins.push(smokePin)
            else if (contract.mode && contract.mode !== 'invalid') reportPins.push(smokePin)
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

    for (const missing of missingRequiredEdges(input.flow)) blockers.push(missing)

    if (sawQueries) smoke.push({ id: 'analysis', label: 'Analysis', pins: [], needsRows: false })
    if (reportPins.length) smoke.push({ id: 'report', label: 'Report', pins: reportPins, needsRows: true })
    if (csvPins.length) smoke.push({ id: 'csv', label: 'CSV', pins: csvPins, needsRows: true })
    if (pdf) smoke.push({ id: 'pdf', label: 'PDF', pins: [], needsRows: false })
    return { blockers, smoke }
}

const SCALAR_INPUT = new Set([
    'string',
    'number',
    'boolean',
    'password',
    'options',
    'json',
    'array',
    'code',
    'file',
    'date',
    'asyncOptions',
    'credential',
    'tabs',
    'condition',
    'datagrid',
    'asyncMultiOptions',
    'multiOptions'
])

function anchorList(data: Record<string, unknown>): Array<{ name: string; label: string; optional: boolean }> {
    const anchors = Array.isArray(data.inputAnchors) ? data.inputAnchors : null
    const source =
        anchors ||
        (Array.isArray(data.inputParams)
            ? data.inputParams.filter((item) => {
                  if (!item || typeof item !== 'object') return false
                  const type = String((item as { type?: string }).type || '')
                  const kind = type.split('|')[0].trim()
                  return kind && !SCALAR_INPUT.has(kind) && /[A-Z]/.test(kind)
              })
            : [])
    return source
        .filter((item) => item && typeof item === 'object' && (item as { name?: string }).name)
        .map((item) => {
            const anchor = item as { name?: string; label?: string; optional?: boolean }
            return { name: String(anchor.name), label: String(anchor.label || anchor.name), optional: anchor.optional === true }
        })
}

function edgeField(edge: { targetHandle?: unknown; target?: unknown }): string {
    const targetId = String(edge.target || '')
    const handle = String(edge.targetHandle || '')
    if (!handle || handle === targetId) return ''
    if (handle.startsWith('{')) {
        try {
            const parsed = JSON.parse(handle) as { name?: string }
            if (parsed?.name) return String(parsed.name)
        } catch {
            // A plain handle id is the other saved form.
        }
    }
    const marker = '-input-'
    const at = handle.indexOf(marker)
    if (at === -1) return ''
    return handle.slice(at + marker.length).split('-')[0]
}

function anchorConnected(
    inputs: Record<string, unknown>,
    name: string,
    nodeId: string,
    edges: Array<{ target?: unknown; targetHandle?: unknown }>
): boolean {
    if (edges.some((edge) => String(edge.target || '') === nodeId && edgeField(edge) === name)) return true
    const value = inputs[name]
    if (typeof value === 'string' && value.includes('{{') && value.includes('}}')) return true
    return Array.isArray(value) && value.length > 0
}

function missingRequiredEdges(flow: { nodes?: unknown; edges?: unknown }): Blocker[] {
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
    const edges = (Array.isArray(flow.edges) ? flow.edges : []).filter((edge) => edge && typeof edge === 'object') as Array<{
        target?: unknown
        targetHandle?: unknown
    }>
    const blockers: Blocker[] = []
    for (const node of nodes) {
        const data = nodeData(node)
        if (!data) continue
        const nodeId = String((node as { id?: string }).id || data.id || '')
        const label = String(data.label || data.name || 'A card')
        const inputs = data.inputs && typeof data.inputs === 'object' ? (data.inputs as Record<string, unknown>) : {}
        for (const anchor of anchorList(data)) {
            if (anchor.optional || anchorConnected(inputs, anchor.name, nodeId, edges)) continue
            blockers.push({
                id: `edge:${nodeId}:${anchor.name}`,
                severity: 'attention',
                message: `${label} needs a connection to ${anchor.label}. Connect it, then check this flow again.`,
                action: 'none',
                nodeId
            })
        }
    }
    return blockers
}

// Card lookups use the node id: the first match is read, and a write visits every match.
// A missing id and a repeated id are the same collision, so verification stops before it writes.
export function nodeIdProblems(flow: { nodes?: unknown } | null | undefined): Array<{ nodeId: string; kind: 'missing' | 'duplicate' }> {
    const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
    const seen = new Map<string, number>()
    const problems: Array<{ nodeId: string; kind: 'missing' | 'duplicate' }> = []
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const id = String((node as { id?: unknown }).id ?? '').trim()
        if (!id) {
            problems.push({ nodeId: '', kind: 'missing' })
            continue
        }
        const count = (seen.get(id) || 0) + 1
        seen.set(id, count)
        if (count > 1) problems.push({ nodeId: id, kind: 'duplicate' })
    }
    return problems
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
