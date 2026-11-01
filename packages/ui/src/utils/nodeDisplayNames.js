// Names shown on screen for a few nodes whose saved label reads as jargon. Display only: the saved label,
// name, type and category in a flow stay exactly as they are, so existing flows load and save unchanged.

const POSTGRES_SAVED_LABEL = 'PostgreSQL MCP'

export const NODE_DISPLAY = {
    postgreSQLMCP: {
        savedLabel: POSTGRES_SAVED_LABEL,
        label: 'Postgres (MCP)',
        subtitle: 'Postgres database tool. Any agent or flow can use it.',
        group: 'Database',
        aliases: ['postgres', 'postgresql', 'postgresql mcp', 'mcp', 'database', 'sql'],
        docs: 'https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/analyst.md'
    }
}

export const SPECIALIST_NODE = 'harnessSpecialist'
export const POSTGRES_NODE = 'postgreSQLMCP'

// The label to draw for a node. A label the flow saved that differs from the stock one is shown as saved.
export function displayLabel(data) {
    const entry = NODE_DISPLAY[data?.name]
    const saved = typeof data?.label === 'string' ? data.label : ''
    if (!entry) return saved
    if (!saved || saved === entry.savedLabel) return entry.label
    // A duplicated card saves the stock label plus " (n)", once per duplication, and it reads the same way.
    const copy = saved.startsWith(`${entry.savedLabel} (`) ? saved.slice(entry.savedLabel.length).match(/^(?: \(\d+\))+$/) : null
    if (copy) return `${entry.label}${copy[0]}`
    return saved
}

// The guide the info dialog opens. The node's saved documentation link is left as it is.
export function docsLink(data) {
    return NODE_DISPLAY[data?.name]?.docs || data?.documentation || ''
}

export function displaySubtitle(name) {
    return NODE_DISPLAY[name]?.subtitle || ''
}

// The Add Nodes heading a node is listed under. The node's own category is never changed.
export function paletteGroup(node) {
    return NODE_DISPLAY[node?.name]?.group || node?.category
}

// Moves nodes with a display group under that heading. Returns new objects, the node objects are the same ones.
export function regroupForPalette(grouped, expanded = {}) {
    const nodes = {}
    const open = { ...expanded }
    for (const category of Object.keys(grouped || {})) {
        for (const node of grouped[category] || []) {
            const group = paletteGroup(node) || category
            nodes[group] = nodes[group] || []
            nodes[group].push(node)
            if (group !== category && open[group] === undefined) open[group] = Boolean(expanded[category])
        }
    }
    return { nodes, expanded: open }
}

// Words a search can match for a node: its name, saved label, shown label and aliases.
export function nodeSearchTerms(node) {
    const entry = NODE_DISPLAY[node?.name]
    const terms = [node?.name, node?.label]
    if (entry) terms.push(entry.label, entry.group, ...entry.aliases)
    return terms.filter((term) => typeof term === 'string' && term)
}

function capitalize(text) {
    const value = String(text || '').trim()
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : ''
}

export function specialistTitle(node) {
    const name = node?.data?.inputs?.specialistName
    return capitalize(typeof name === 'string' && name.trim() ? name : node?.data?.label || node?.id)
}

// Who uses a Postgres tool, and which data a specialist reads, from the edges on the canvas right now.
// Computed when drawn and never saved.
export function linkNote(nodeId, nodes, edges) {
    const list = Array.isArray(nodes) ? nodes : []
    const byId = new Map(list.map((node) => [node.id, node]))
    const self = byId.get(nodeId)
    const name = self?.data?.name
    if (name !== POSTGRES_NODE && name !== SPECIALIST_NODE) return ''
    const seen = new Set()
    const names = []
    for (const edge of Array.isArray(edges) ? edges : []) {
        if (name === POSTGRES_NODE && edge?.source === nodeId) {
            const target = byId.get(edge.target)
            if (target?.data?.name !== SPECIALIST_NODE || seen.has(target.id)) continue
            seen.add(target.id)
            names.push(specialistTitle(target))
        }
        if (name === SPECIALIST_NODE && edge?.target === nodeId) {
            const source = byId.get(edge.source)
            if (source?.data?.name !== POSTGRES_NODE || seen.has(source.id)) continue
            seen.add(source.id)
            names.push(displayLabel(source.data))
        }
    }
    if (!names.length) return ''
    return name === POSTGRES_NODE ? `Used by: ${names.join(', ')}` : `Data: ${names.join(', ')}`
}

// Postgres tools wired into a specialist, for the analyst checks that need their settings.
export function wiredPostgres(nodeId, nodes, edges) {
    const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]))
    const out = []
    for (const edge of Array.isArray(edges) ? edges : []) {
        if (edge?.target !== nodeId) continue
        const source = byId.get(edge.source)
        if (source?.data?.name === POSTGRES_NODE && !out.includes(source)) out.push(source)
    }
    return out
}
