// Shared with the run engine, queue workers and loopback gateway, including starts outside the server.
const availability = require('../../../harness/availability.cjs') as {
    supervisorUnavailable: (dataDir?: string) => boolean
    runtimeState: (dataDir?: string) => string
    assertRuntimeAvailable: (dataDir?: string) => void
    selectAgentEngine: (name: unknown) => 'native' | 'hermes'
    assertSelectedHarnessAvailable: (
        name: unknown,
        target: { record?: unknown; canvas?: RuntimeFlow; workspaceId?: string; readFlowData?: () => Promise<string> }
    ) => void | Promise<void>
}

export const assertSelectedHarnessAvailable = availability.assertSelectedHarnessAvailable
export const supervisorUnavailable = availability.supervisorUnavailable
export const selectAgentEngine = availability.selectAgentEngine
export const runtimeState = availability.runtimeState
export const assertRuntimeAvailable = availability.assertRuntimeAvailable

/** Runtime refusals also come from the shared runtime as plain errors with these fields. */
export function isRuntimeUnavailableError(error: unknown): error is Error & {
    statusCode: number
    code: string
    retryAfterSeconds?: number
} {
    const failure = error as { statusCode?: unknown; code?: unknown } | null
    return failure instanceof Error && failure.statusCode === 503 && failure.code === 'RUNTIME_UNAVAILABLE'
}

type RuntimeFlow = { id?: string; name?: string; workspaceId?: string; type?: string | null; flowData: string }

/** Check only an authorized flow. Resolve a saved caller target only within its own workspace. */
export function assertFlowRuntimeAvailable(flow: RuntimeFlow, overrides?: unknown, readFlowData?: () => Promise<string>) {
    if (flow.type === 'HARNESS') return assertSelectedHarnessAvailable(flow.name, { canvas: flow, readFlowData })
    type CanvasNode = { data?: { name?: string; inputs?: Record<string, unknown> } }
    let canvas: { nodes?: CanvasNode[] }
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
    if (!Array.isArray(canvas?.nodes)) return
    if (canvas.nodes.some((node) => hasHarnessTool(node?.data?.inputs))) return assertRuntimeAvailable()
    const direct = canvas.nodes.filter((node) => node?.data?.name === 'harness')
    if (!direct.length) return
    // A mixed graph or a per-request node override can select another team after this check.
    if (
        direct.length !== canvas.nodes.length ||
        (overrides != null &&
            (typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).some((k) => k !== 'sessionId')))
    )
        return assertRuntimeAvailable()
    const names = [...new Set(direct.map((node) => node.data?.inputs?.harnessName))]
    if (names.some((name) => availability.selectAgentEngine(name) !== 'native')) return assertRuntimeAvailable()
    return Promise.all(names.map((name) => assertSelectedHarnessAvailable(name, { workspaceId: flow.workspaceId }))).then(() => {})
}
