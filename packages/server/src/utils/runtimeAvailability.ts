// Shared with the run engine, queue workers and loopback gateway, including starts outside the server.
const availability = require('../../../harness/availability.cjs') as {
    runtimeState: (dataDir?: string) => string
    assertRuntimeAvailable: (dataDir?: string) => void
}

export const runtimeState = availability.runtimeState
export const assertRuntimeAvailable = availability.assertRuntimeAvailable

/** Check only an authorized flow. Ordinary flows and operator recovery routes remain usable. */
export function assertFlowRuntimeAvailable(flow: { type?: string | null; flowData: string }) {
    if (flow.type === 'HARNESS') return assertRuntimeAvailable()
    let canvas: { nodes?: Array<{ data?: { name?: string; inputs?: unknown } }> }
    try {
        canvas = JSON.parse(flow.flowData)
    } catch {
        return
    }
    // Agentflow tools nest their selection/config inside inputs instead of using a Harness node.
    const hasHarnessTool = (value: unknown, depth = 0): boolean => {
        if (!value || typeof value !== 'object' || depth > 64) return false
        if (Array.isArray(value)) return value.some((item) => hasHarnessTool(item, depth + 1))
        const item = value as Record<string, unknown>
        return item.agentSelectedTool === 'harness' || Object.values(item).some((child) => hasHarnessTool(child, depth + 1))
    }
    if (Array.isArray(canvas?.nodes) && canvas.nodes.some((node) => node?.data?.name === 'harness' || hasHarnessTool(node?.data?.inputs))) {
        assertRuntimeAvailable()
    }
}
