/**
 * The harness payload to save with an agent reply when a Harness node ran as the agent's tool. The last call wins, and
 * the text is the reply the chat shows, so a reload renders the same answer with that run's header and token totals.
 */
export function harnessToolPayloadFor(payloads: Record<string, any>[] | undefined, replyText: string) {
    const last = Array.isArray(payloads) ? payloads[payloads.length - 1] : undefined
    if (!last || typeof last !== 'object' || !last.trace) return undefined
    return {
        text: replyText,
        harness: last.harness,
        agents: Array.isArray(last.agents) ? last.agents : [],
        sources: Array.isArray(last.sources) ? last.sources : [],
        artifacts: [],
        ...(last.timings ? { timings: last.timings } : {}),
        ...(last.report ? { report: last.report } : {}),
        trace: last.trace,
        viaTool: true
    }
}
