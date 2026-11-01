// How the side panel lays out the Postgres (MCP) card: plain-language groups and labels. Display only.
// Each field is a shallow copy with a friendlier label, hint or placeholder. Field names, values and the saved
// inputParams on the node are never touched, so a flow saves exactly what it saved before.

import { POSTGRES_NODE } from './nodeDisplayNames'

export const POSTGRES_GROUPS = [
    { key: 'source', title: 'Data source', fields: ['credential'] },
    { key: 'see', title: 'What it can see', fields: ['analystRelations', 'mcpActions', 'analystRules'] },
    { key: 'model', title: 'Model', fields: [] },
    { key: 'limits', title: 'Limits', fields: ['analystRowCap', 'analystTimeoutSeconds'], collapsed: true },
    { key: 'advanced', title: 'Advanced', fields: ['analystAllowedFunctions', 'allowPinDefinitions'], collapsed: true }
]

export const MODEL_NOTE =
    'This tool has no model of its own. The agent or specialist it is connected to reads your question and writes the SQL.'

const FIELD_TEXT = {
    credential: { label: 'Database connection' },
    mcpActions: { label: 'Tools it can use' },
    analystRelations: { label: 'Tables and views' },
    analystRules: { label: 'Notes for the analyst' },
    analystRowCap: { label: 'Most rows per query', placeholder: 'Server limit (100 by default)' },
    analystTimeoutSeconds: { label: 'Query time limit (seconds)', placeholder: 'Server limit (15 by default)' },
    analystAllowedFunctions: {
        label: 'Allowed functions',
        hint: 'Extra database functions queries may call, one per line. Most setups leave this empty.'
    },
    allowPinDefinitions: { label: 'Let the analyst read saved query SQL' }
}

const shown = (param) => !param.hidden && param.display !== false

export function isPostgresPanel(data) {
    return data?.name === POSTGRES_NODE
}

// A copy of the field with the on-screen label and placeholder. The original label stays in the tooltip.
export function displayParam(param) {
    const text = FIELD_TEXT[param?.name]
    if (!text) return param
    const copy = { ...param }
    if (text.label && text.label !== param.label) {
        copy.label = text.label
        copy.description = [param.description, `Saved as "${param.label}".`].filter(Boolean).join(' ')
    }
    if (text.placeholder && !param.placeholder) copy.placeholder = text.placeholder
    return copy
}

export function fieldHint(name) {
    return FIELD_TEXT[name]?.hint || ''
}

// The groups with their fields, in order. A field this list does not know goes under Advanced.
export function postgresGroups(data, { hide = [] } = {}) {
    const params = Array.isArray(data?.inputParams) ? data.inputParams.filter(shown) : []
    const placed = new Set(POSTGRES_GROUPS.flatMap((group) => group.fields))
    const extra = params.filter((param) => !placed.has(param.name) && param.name !== 'pinnedQueries')
    return POSTGRES_GROUPS.map((group) => {
        const names = group.key === 'advanced' ? [...group.fields, ...extra.map((param) => param.name)] : group.fields
        const fields = names
            .filter((name) => !hide.includes(name))
            .map((name) => params.find((param) => param.name === name))
            .filter(Boolean)
            .map(displayParam)
        return { ...group, fields }
    })
}

// How many fields in a folded group have a value set, for its header.
export function setCount(group, inputs = {}) {
    return group.fields.filter((param) => {
        const value = inputs?.[param.name]
        return value !== undefined && value !== null && value !== '' && value !== false
    }).length
}
