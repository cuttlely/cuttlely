// Destination credentials match by name and type only when one authorized row matches.
// An existing id that is already on this server is reused. An optional empty slot stays empty.
// A required credential that is still empty blocks Ready to publish.
// A card can allow more than one credential type. The type named in the file is used when it is one of those types.
// This is the same uniqueness rule as import rebind: one name and one credential type.

export interface CredentialRow {
    id: string
    name: string
    credentialName: string
}

export interface CredentialMark {
    name: string
    credentialName: string
}

export interface ConnectionSlot {
    id: string
    nodeId: string
    nodeLabel: string
    expectedType: string
    allowedTypes: string[]
    required: boolean
    needed: boolean
    currentId: string
    mark: CredentialMark | null
}

export type ConnectionStatus = 'reused' | 'matched' | 'missing' | 'ambiguous' | 'empty'

export interface ConnectionResolution {
    slot: ConnectionSlot
    status: ConnectionStatus
    credentialId: string
    options: Array<{ id: string; name: string }>
}

const MARK = '$credential'

function isMark(value: unknown): value is { [MARK]: { name?: unknown; credentialName?: unknown } } {
    return (
        Boolean(value) &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value as object).length === 1 &&
        MARK in (value as object)
    )
}

export function readMark(value: unknown): CredentialMark | null {
    if (!isMark(value)) return null
    const ref = value[MARK]
    const name = ref && typeof ref.name === 'string' ? ref.name.trim() : ''
    const credentialName = ref && typeof ref.credentialName === 'string' ? ref.credentialName.trim() : ''
    if (!name || !credentialName) return null
    return { name, credentialName }
}

function credentialParam(data: { inputParams?: unknown; credential?: unknown }): { names: string[]; optional: boolean } | null {
    const params = Array.isArray(data.inputParams) ? data.inputParams : []
    const fromInputs = params.find((item) => item && typeof item === 'object' && (item as { type?: string }).type === 'credential') as
        | { credentialNames?: unknown; optional?: boolean }
        | undefined
    const spec =
        fromInputs ||
        (data.credential && typeof data.credential === 'object'
            ? (data.credential as { credentialNames?: unknown; optional?: boolean })
            : null)
    if (!spec) return null
    const names = Array.isArray(spec.credentialNames) ? spec.credentialNames.filter((name) => typeof name === 'string' && name) : []
    return { names: names as string[], optional: spec.optional === true }
}

function stringId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

export function connectionSlots(flow: { nodes?: unknown }): ConnectionSlot[] {
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
    const slots: ConnectionSlot[] = []
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const data = (node as { data?: unknown }).data
        if (!data || typeof data !== 'object') continue
        const record = data as {
            id?: string
            label?: string
            name?: string
            category?: string
            credential?: unknown
            inputParams?: unknown
            inputs?: Record<string, unknown>
        }
        const spec = credentialParam(record)
        const inputs = record.inputs && typeof record.inputs === 'object' ? record.inputs : {}
        const direct = record.credential
        const inputId = inputs.FLOWISE_CREDENTIAL_ID
        const mark = readMark(direct) || readMark(inputId)
        const currentId = stringId(direct) || stringId(inputId)
        if (!spec && !mark && !currentId) continue
        const names = spec?.names || []
        const markedType = mark?.credentialName || ''
        const allowedTypes = names.length ? names : markedType ? [markedType] : []
        const expectedType = (markedType && names.includes(markedType) ? markedType : names[0]) || markedType || ''
        const nodeId = String((node as { id?: string }).id || record.id || '')
        const queries = inputs.pinnedQueries
        const hasQueries =
            typeof queries === 'string'
                ? queries.includes('"sql"') || queries.includes('"name"')
                : Array.isArray(queries) && queries.length > 0
        const category = String(record.category || '')
        const requiredSpec = Boolean(spec && spec.optional !== true)
        const needed = Boolean(
            requiredSpec ||
                mark ||
                currentId ||
                hasQueries ||
                category === 'Chat Models' ||
                category === 'Embeddings' ||
                category === 'Chat Model'
        )
        slots.push({
            id: `${nodeId}:credential`,
            nodeId,
            nodeLabel: String(record.label || record.name || nodeId),
            expectedType,
            allowedTypes,
            required: spec ? spec.optional !== true : Boolean(mark || currentId),
            needed,
            currentId,
            mark
        })
    }
    return slots
}

function acceptsType(type: string, slot: ConnectionSlot): boolean {
    const types = slot.allowedTypes?.length ? slot.allowedTypes : slot.expectedType ? [slot.expectedType] : []
    if (!types.length) return true
    return types.includes(type)
}

function optionsFor(rows: CredentialRow[], slot: ConnectionSlot): Array<{ id: string; name: string }> {
    return rows.filter((row) => row.id && acceptsType(row.credentialName, slot)).map((row) => ({ id: row.id, name: row.name }))
}

export function resolveSlot(slot: ConnectionSlot, credentials: CredentialRow[], choiceId?: string): ConnectionResolution {
    const rows = Array.isArray(credentials) ? credentials.filter((row) => row && row.id && row.name && row.credentialName) : []
    const options = optionsFor(rows, slot)
    const base = { slot, options, credentialId: '' }

    if (choiceId) {
        const chosen = rows.find((row) => row.id === choiceId && acceptsType(row.credentialName, slot))
        if (!chosen) return { ...base, status: 'missing' }
        return { ...base, status: 'matched', credentialId: chosen.id }
    }

    if (slot.currentId) {
        const existing = rows.find((row) => row.id === slot.currentId)
        if (existing && acceptsType(existing.credentialName, slot)) {
            return { ...base, status: 'reused', credentialId: existing.id }
        }
    }

    if (slot.mark) {
        if (!acceptsType(slot.mark.credentialName, slot)) {
            return { ...base, status: 'missing' }
        }
        const matches = rows.filter((row) => row.name === slot.mark?.name && row.credentialName === slot.mark?.credentialName)
        if (matches.length === 1) return { ...base, status: 'matched', credentialId: matches[0].id }
        if (matches.length > 1) return { ...base, status: 'ambiguous' }
        return { ...base, status: 'missing' }
    }

    if (!slot.currentId) return { ...base, status: 'empty' }
    return { ...base, status: 'missing' }
}

export function applyCredential(flow: { nodes?: unknown }, slotId: string, credentialId: string): { nodes?: unknown } {
    const copy = structuredClone(flow) as { nodes?: unknown }
    const nodes = Array.isArray(copy.nodes) ? copy.nodes : []
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const data = (node as { data?: { inputs?: Record<string, unknown>; credential?: unknown } }).data
        if (!data) continue
        const nodeId = String((node as { id?: string }).id || '')
        if (`${nodeId}:credential` !== slotId) continue
        data.credential = credentialId
        data.inputs = { ...(data.inputs || {}), FLOWISE_CREDENTIAL_ID: credentialId }
    }
    return copy
}
