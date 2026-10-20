export const TEMPLATE_SETTINGS_NOTE = 'connection settings are not included in templates; re-enter them after import'

const droppedRows = (flow) => {
    const rows = flow && typeof flow === 'object' && Array.isArray(flow.droppedSettings) ? flow.droppedSettings : []
    return rows.filter((row) => row && typeof row === 'object' && Array.isArray(row.inputs) && row.inputs.length > 0)
}

const rowLabel = (row) => (typeof row.label === 'string' && row.label ? row.label : typeof row.nodeId === 'string' ? row.nodeId : 'node')

/** Empty when nothing was left out. Otherwise the fixed note plus each node label and its input names. */
export const templateSettingsMessage = (flowOrText) => {
    let flow = flowOrText
    if (typeof flowOrText === 'string') {
        if (!flowOrText.trim()) return ''
        try {
            flow = JSON.parse(flowOrText)
        } catch {
            return ''
        }
    }
    const rows = droppedRows(flow)
    if (!rows.length) return ''
    const detail = rows
        .map((row) => {
            const inputs = row.inputs.filter((name) => typeof name === 'string' && name).join(', ')
            return `${rowLabel(row)} (${inputs})`
        })
        .join('; ')
    return `${TEMPLATE_SETTINGS_NOTE} ${detail}`
}
