// Which flow lists the evaluation dialog may load. Custom assistants are not a source:
// the runner posts every selected id to the prediction route, which only resolves chatflows and agentflows.

export const EVALUATION_FLOW_CHOICES = [
    { permission: 'chatflows:view', type: 'Chatflow', label: 'Chatflows', key: 'chatflows' },
    { permission: 'agentflows:view', type: 'Agentflow v2', label: 'Agentflows (v2)', key: 'agentflows' }
]

export function requestsForRole(hasPermission) {
    const allow = typeof hasPermission === 'function' ? hasPermission : () => false
    return {
        chatflows: Boolean(allow('chatflows:view')),
        agentflows: Boolean(allow('agentflows:view')),
        assistants: false
    }
}

// A source that has not returned, or that failed, is skipped. The lists that did return are kept.
export function evaluationFlows(hasPermission, responses = {}) {
    const allow = typeof hasPermission === 'function' ? hasPermission : () => false
    const flows = []
    const flowTypes = []
    let ready = false
    for (const source of EVALUATION_FLOW_CHOICES) {
        if (!allow(source.permission)) continue
        const rows = responses[source.key]
        if (!Array.isArray(rows)) continue
        ready = true
        flowTypes.push(source.type)
        for (const flow of rows) {
            flows.push({
                label: flow.name,
                name: flow.id,
                type: source.type,
                description: source.type
            })
        }
    }
    return { ready, flows, flowTypes }
}
