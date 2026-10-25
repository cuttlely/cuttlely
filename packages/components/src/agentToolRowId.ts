// One id per harness row on an agentflow Agent. The server and the canvas both use this.
// An id already stored on the row, its node id, or the tool config's id is kept.
// A row with none of those gets harness_tool_N, the smallest free N, in list order, and that id is written
// on the row. It does not depend on the rest of the config, so Return Direct does not move it.
// Removing an earlier row does not change an id that was already written.

type AgentToolRow = {
    id?: unknown
    nodeId?: unknown
    agentSelectedTool?: unknown
    agentSelectedToolConfig?: { id?: unknown; nodeId?: unknown } | null
}

function textId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function explicitRowId(tool: AgentToolRow): string {
    const config = tool.agentSelectedToolConfig || {}
    return textId(tool.id) || textId(tool.nodeId) || textId(config.id) || textId(config.nodeId)
}

const ROW_ID = /^harness_tool_(\d+)$/

export function ensureAgentToolRowIds(tools: unknown): { ids: string[]; changed: boolean } {
    const list = Array.isArray(tools) ? (tools as AgentToolRow[]) : []
    const ids = new Array<string>(list.length).fill('')
    const used = new Set<string>()
    const numbers = new Set<number>()
    let changed = false

    for (let index = 0; index < list.length; index += 1) {
        const tool = list[index]
        if (!tool || tool.agentSelectedTool !== 'harness') continue
        const id = explicitRowId(tool)
        if (!id || used.has(id)) continue
        used.add(id)
        ids[index] = id
        const match = ROW_ID.exec(id)
        if (match) numbers.add(Number(match[1]))
    }

    let next = 0
    for (let index = 0; index < list.length; index += 1) {
        const tool = list[index]
        if (!tool || tool.agentSelectedTool !== 'harness' || ids[index]) continue
        while (numbers.has(next) || used.has(`harness_tool_${next}`)) next += 1
        const id = `harness_tool_${next}`
        numbers.add(next)
        used.add(id)
        next += 1
        if (tool.id !== id) {
            tool.id = id
            changed = true
        }
        ids[index] = id
    }

    return { ids, changed }
}
