// Shared with the run engine, queue workers and loopback gateway, including starts outside the server.
const availability = require('../../../harness/availability.cjs') as {
    supervisorUnavailable: (dataDir?: string) => boolean
    runtimeState: (dataDir?: string) => string
    assertRuntimeAvailable: (dataDir?: string) => void
    selectAgentEngine: (name: unknown) => 'native' | 'hermes'
    assertSelectedHarnessAvailable: (
        name: unknown,
        target: { record?: unknown; canvas?: RuntimeFlow; workspaceId?: string; readSelection?: () => Promise<CanvasSelection> }
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

type CanvasSelection = { flowData: string; published: boolean; tryOwner?: string }
type RuntimeFlow = { id?: string; name?: string; workspaceId?: string; type?: string | null; flowData: string }

type CanvasNode = { id?: string; data?: { name?: string; inputs?: Record<string, unknown> } }
type CanvasGraph = { nodes?: CanvasNode[]; edges?: { source?: string; target?: string }[] }

const { nodes } = require('@cuttlely/components/module-catalog') as { nodes: { name: string; category: string }[] }
const modelNames = new Set(nodes.filter((node) => node.category === 'Chat Models').map((node) => node.name))

// A Tool Agent can call a statically connected Harness card. Only the installed model catalog and built-in
// memory nodes qualify as companions. Graph-supplied category labels do not establish their behavior.
function staticHarnessToolAgent(canvas: CanvasGraph, harnesses: CanvasNode[]) {
    const nodes = canvas.nodes || []
    if (nodes.some((node) => !node || typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(node.id))) return false
    const agent = nodes.find((node) => node.data?.name === 'toolAgent')
    const model = nodes.find((node) => modelNames.has(node.data?.name || ''))
    const memory = nodes.find((node) => ['bufferMemory', 'bufferWindowMemory'].includes(node.data?.name || ''))
    if (!agent || !model || !memory || nodes.length !== harnesses.length + 3) return false
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length) return false
    const ref = (node: CanvasNode) => '{{' + node.id + '.data.instance}}'
    const selected = agent.data?.inputs
    if (selected?.model !== ref(model) || selected?.memory !== ref(memory) || !Array.isArray(selected?.tools)) return false
    const tools = new Set(selected.tools)
    if (selected.tools.length !== harnesses.length || tools.size !== harnesses.length || !harnesses.every((node) => tools.has(ref(node))))
        return false
    const sources = new Set([model.id, memory.id, ...harnesses.map((node) => node.id)])
    return (
        Array.isArray(canvas.edges) &&
        canvas.edges.length === sources.size &&
        canvas.edges.every((edge) => edge?.target === agent.id && sources.delete(edge.source))
    )
}

/** Check only an authorized flow. Resolve a saved caller target only within its own workspace. */
export function assertFlowRuntimeAvailable(flow: RuntimeFlow, overrides?: unknown, readSelection?: () => Promise<CanvasSelection>) {
    if (flow.type === 'HARNESS') return assertSelectedHarnessAvailable(flow.name, { canvas: flow, readSelection })
    if (!supervisorUnavailable()) return
    let canvas: CanvasGraph
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
    // Neither session selection nor a caller-supplied receipt field can choose a team.
    // Only the private server-side upload registry can supply file authority.
    if (
        (direct.length !== canvas.nodes.length && !staticHarnessToolAgent(canvas, direct)) ||
        (overrides != null &&
            (typeof overrides !== 'object' ||
                Array.isArray(overrides) ||
                Object.keys(overrides).some((k) => k !== 'sessionId' && k !== 'managedUploadReceipts')))
    )
        return assertRuntimeAvailable()
    const names = [...new Set(direct.map((node) => node.data?.inputs?.harnessName))]
    if (
        names.some(
            (name) =>
                typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || availability.selectAgentEngine(name) !== 'native'
        )
    )
        return assertRuntimeAvailable()
    return Promise.all(names.map((name) => availability.assertSelectedHarnessAvailable(name, { workspaceId: flow.workspaceId }))).then(
        () => {}
    )
}
