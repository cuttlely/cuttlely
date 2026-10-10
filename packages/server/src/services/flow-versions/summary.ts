// Plain-words names for a version, made from what changed in the files.
// No model call: the same change always gets the same name.
import { canonicalJson, FlowFiles, normalizeStoredNode } from './serialize'

export interface ChangeSummary {
    title: string
    details: string[]
}

type Obj = Record<string, any>

function parse(content: string | undefined): any {
    if (content === undefined) return undefined
    try {
        return JSON.parse(content)
    } catch {
        return undefined
    }
}

// A node file as written now (see normalizeStoredNode), so older files compare cleanly.
function nodeFile(files: FlowFiles, file: string): any {
    const node = parse(files[file])
    return node === undefined ? undefined : normalizeStoredNode(node)
}

function nodeEntries(files: FlowFiles): Map<string, { label: string; file: string }> {
    const flow = parse(files['flow.json'])
    const out = new Map<string, { label: string; file: string }>()
    for (const entry of Array.isArray(flow?.nodes) ? flow.nodes : []) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.file !== 'string') continue
        const node = parse(files[entry.file])
        const label = (node?.data?.label as string) || (node?.data?.name as string) || entry.id
        out.set(entry.id, { label, file: entry.file })
    }
    return out
}

function stem(file: string): string {
    return file.slice('nodes/'.length, -'.json'.length)
}

function changedInputs(before: FlowFiles, after: FlowFiles, file: string): string[] {
    const a: Obj = nodeFile(before, file)?.data?.inputs || {}
    const b: Obj = nodeFile(after, file)?.data?.inputs || {}
    const names = new Set([...Object.keys(a), ...Object.keys(b)])
    const prefix = `prompts/${stem(file)}.`
    const changed: string[] = []
    for (const name of [...names].sort()) {
        const left = JSON.stringify(a[name])
        const right = JSON.stringify(b[name])
        const textA = a[name]?.$text
        const textB = b[name]?.$text
        const textChanged =
            typeof textA === 'string' && typeof textB === 'string' && textA.startsWith(prefix) && before[textA] !== after[textB]
        if (left !== right || textChanged) changed.push(name)
    }
    return changed
}

// The label the canvas shows for an input, from the node definition, else the name in words.
function inputLabel(files: FlowFiles, file: string, name: string): string {
    if (name === 'FLOWISE_CREDENTIAL_ID' || name === 'credential') return 'credential'
    const definition = parse(files[`nodes/${stem(file)}.definition.json`])
    for (const key of ['inputParams', 'inputAnchors']) {
        const params = Array.isArray(definition?.[key]) ? definition[key] : []
        const found = params.find((param: Obj) => param && param.name === name && typeof param.label === 'string' && param.label.trim())
        if (found) return found.label.trim()
    }
    const words = name
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim()
        .toLowerCase()
    return words || name
}

function credentialChanged(before: FlowFiles, after: FlowFiles, oldFile: string, newFile: string): boolean {
    return (
        canonicalJson(nodeFile(before, oldFile)?.data?.credential ?? null) !==
        canonicalJson(nodeFile(after, newFile)?.data?.credential ?? null)
    )
}

// True when a node's position changed. Width, height and the viewport do not count.
function positionsChanged(before: FlowFiles, after: FlowFiles): boolean {
    const a = parse(before['layout.json'])?.nodes || {}
    const b = parse(after['layout.json'])?.nodes || {}
    return Object.keys(b).some((id) => a[id] && JSON.stringify(a[id].position) !== JSON.stringify(b[id].position))
}

function list(items: string[], limit = 3): string {
    if (items.length <= limit) return items.join(', ')
    return `${items.slice(0, limit).join(', ')} and ${items.length - limit} more`
}

export function summarizeChange(before: FlowFiles | null, after: FlowFiles | null, name: string): ChangeSummary {
    if (!before && after) return { title: `Created ${name}`, details: [] }
    if (before && !after) return { title: `Deleted ${name}`, details: [] }
    if (!before || !after) return { title: `Saved ${name}`, details: [] }

    const details: string[] = []
    const parts: string[] = []
    const oldName = parse(before['flow.json'])?.name
    const newName = parse(after['flow.json'])?.name
    if (oldName && newName && oldName !== newName) {
        parts.push(`Renamed to ${newName}`)
        details.push(`Renamed from ${oldName} to ${newName}`)
    }

    const oldNodes = nodeEntries(before)
    const newNodes = nodeEntries(after)
    const added = [...newNodes.keys()].filter((id) => !oldNodes.has(id))
    const removed = [...oldNodes.keys()].filter((id) => !newNodes.has(id))
    const changed: { label: string; inputs: string[]; other: boolean }[] = []
    for (const [id, entry] of newNodes) {
        const old = oldNodes.get(id)
        if (!old) continue
        const labels = changedInputs(before, after, entry.file).map((input) => inputLabel(after, entry.file, input))
        if (credentialChanged(before, after, old.file, entry.file)) labels.unshift('credential')
        const inputs = [...new Set(labels)]
        const nodeFileChanged =
            before[old.file] !== after[entry.file] &&
            canonicalJson(nodeFile(before, old.file)) !== canonicalJson(nodeFile(after, entry.file))
        const definition = `nodes/${stem(entry.file)}.definition.json`
        const definitionChanged = before[`nodes/${stem(old.file)}.definition.json`] !== after[definition]
        if (inputs.length || nodeFileChanged || definitionChanged) {
            changed.push({ label: entry.label, inputs, other: !inputs.length })
        }
    }

    if (changed.length) {
        const first = changed[0]
        parts.push(
            changed.length === 1
                ? first.inputs.length
                    ? `Changed ${list(first.inputs, 2)} on ${first.label}`
                    : `Changed ${first.label}`
                : `Changed ${list(changed.map((item) => item.label))}`
        )
        for (const item of changed) {
            details.push(item.inputs.length ? `Changed ${item.inputs.join(', ')} on ${item.label}` : `Changed ${item.label}`)
        }
    }
    if (added.length) {
        const labels = added.map((id) => newNodes.get(id)!.label)
        parts.push(`Added ${list(labels)}`)
        details.push(`Added ${labels.join(', ')}`)
    }
    if (removed.length) {
        const labels = removed.map((id) => oldNodes.get(id)!.label)
        parts.push(`Removed ${list(labels)}`)
        details.push(`Removed ${labels.join(', ')}`)
    }
    if (before['edges.json'] !== after['edges.json'] && !added.length && !removed.length) {
        parts.push('Rewired connections')
        details.push('Rewired connections')
    }
    if (!parts.length && positionsChanged(before, after)) {
        parts.push('Moved nodes')
    }
    if (!parts.length) parts.push(`Saved ${name}`)

    let title = parts[0]
    for (const part of parts.slice(1)) {
        const next = `${title}; ${part.charAt(0).toLowerCase()}${part.slice(1)}`
        if (next.length > 72) break
        title = next
    }
    if (title.length > 72) title = `${title.slice(0, 71)}…`
    return { title, details }
}
