// Imported test stamps belong to the server that wrote them. The query stays; the stamp does not.

const STAMP_FIELDS = ['testedStamp', 'testedAt', 'testedBy', 'testedColumns', 'columnsChanged']

export function readQueries(value) {
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
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : []
}

export function queryReady(pin) {
    if (!pin || typeof pin.testedStamp !== 'string' || !pin.testedStamp.trim()) return false
    if (pin.needsRetest || pin.columnsChanged) return false
    if (pin.importedVerification === 'untrusted') return false
    return true
}

export function untrustFlow(flow) {
    if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes)) return flow
    const copy = JSON.parse(JSON.stringify(flow))
    for (const node of copy.nodes) {
        const inputs = node?.data?.inputs
        if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, 'pinnedQueries')) continue
        const next = readQueries(inputs.pinnedQueries).map((pin) => {
            const cleared = { ...pin, needsRetest: true, importedVerification: 'untrusted' }
            for (const field of STAMP_FIELDS) delete cleared[field]
            return cleared
        })
        inputs.pinnedQueries = JSON.stringify(next)
    }
    return copy
}

export function statusTitle(status) {
    if (status === 'ready') return 'Ready to publish'
    if (status === 'attention') return 'Needs attention'
    if (status === 'incomplete' || status === 'cancelled') return 'Could not fully verify'
    if (status === 'running') return 'Checking this flow'
    return 'Import & verify'
}

export function progressLine(record) {
    if (!record) return ''
    if (record.phase) return record.phase
    if (record.total) return `Checking saved queries: ${record.checked || 0} of ${record.total}.`
    return ''
}

export const PLACEHOLDER_FLOW = JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })

export function verificationFlowId(propId, stateId) {
    return propId || stateId || ''
}

export function shouldReplaceDraft({ flowText, retryFailures = false, choices = false, resume = false } = {}) {
    return Boolean(flowText) && !retryFailures && !choices && !resume
}

export function connectionNeedsChoice(item) {
    if (!item) return false
    if (item.status === 'missing' || item.status === 'ambiguous') return true
    return item.status === 'empty' && item.required === true
}

export function showResume(record) {
    if (!record || record.publishOffered || record.status === 'idle') return false
    // A running record whose job is still in this process is not ready to resume. After a restart the
    // saved record can still say running while no job is active; that one can be resumed.
    if (record.status === 'running' && record.running !== false) return false
    if ((record.connections || []).some(connectionNeedsChoice)) return false
    if ((record.queries || []).some((item) => item.state === 'failed')) return false
    return !(record.smoke || []).some((item) => (item.id === 'report' || item.id === 'csv') && item.state === 'failed')
}

// Draft status has to land before the canvas text. Save reads the status that was current when the text was recorded.
export function deliverImportedDraft({ status, flowText, onDraftStatus, onImported } = {}) {
    if (status && onDraftStatus) onDraftStatus(status)
    if (flowText && onImported) onImported(flowText)
}

export function canvasPathForImport(flowType, id, agentV2 = false) {
    if (!id) return ''
    if (flowType === 'HARNESS') return `/harnesscanvas/${id}`
    if (flowType === 'ETL') return `/etlcanvas/${id}`
    if (flowType === 'AGENTFLOW') return agentV2 ? `/v2/agentcanvas/${id}` : `/agentcanvas/${id}`
    return `/canvas/${id}`
}

// A flow created by Import & verify has to become the canvas on screen. The address changes to that id,
// and the canvas remembers it so the route update does not load a second copy over the cards.
export function adoptImportedIdentity({ created, flowType, agentV2 = false, remember, replaceState, historyState = null } = {}) {
    const id = created?.id
    if (!id) return null
    if (typeof remember === 'function') remember(id)
    if (typeof replaceState === 'function') replaceState(historyState, '', canvasPathForImport(flowType, id, agentV2))
    return created
}
