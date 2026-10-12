import { HarnessError } from './errors.mjs'

export function payloadFromRun(harnessName, status) {
    if (!status || ['failed', 'error', 'cancelled'].includes(status.status)) {
        const detail = status?.error || status?.message || status?.status || 'failed'
        throw new HarnessError('run_failed', `Harness "${harnessName}" cannot run: ${detail}`)
    }
    const extra = status.cuttlely || status.metadata?.cuttlely || {}
    const agents = Array.isArray(extra.agents) ? extra.agents : Array.isArray(status.agents) ? status.agents : []
    const text = typeof status.output === 'string' ? status.output : typeof extra.text === 'string' ? extra.text : ''
    if (!text.trim()) {
        throw new HarnessError('empty_output', `Harness "${harnessName}" finished without a Harness Prime answer.`)
    }
    return {
        text,
        harness: harnessName,
        agents: agents.map((agent) => ({
            name: agent.name,
            status: agent.status || 'completed',
            ...(agent.error ? { error: agent.error } : {})
        })),
        sources: extra.sources || status.sources || [],
        artifacts: extra.artifacts || status.artifacts || []
    }
}

export function attachHarnessToChatMessage(apiMessage, payload) {
    if (!payload) return apiMessage
    if (payload.text) apiMessage.content = payload.text
    apiMessage.harnessPayload = JSON.stringify({
        text: payload.text,
        harness: payload.harness,
        agents: payload.agents || [],
        sources: payload.sources || [],
        artifacts: payload.artifacts || [],
        ...(payload.timings ? { timings: payload.timings } : {}),
        ...(payload.report ? { report: payload.report } : {}),
        ...(payload.trace ? { trace: payload.trace } : {})
    })
    if (payload.sources) apiMessage.sourceDocuments = JSON.stringify(payload.sources)
    if (payload.artifacts) apiMessage.artifacts = JSON.stringify(payload.artifacts)
    if (payload.agents) apiMessage.agentReasoning = JSON.stringify(payload.agents)
    return apiMessage
}
