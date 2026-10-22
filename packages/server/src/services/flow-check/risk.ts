// Which steps of a chatflow or an agentflow could do something real when the publish check replays a question:
// send a message, post to an API, write to a database or a shared cache, run custom code, or wait for a person.
// The check skips such flows unless the caller says to run them anyway. Unknown steps count as risky.

// Categories whose nodes only read or call a model when a question runs.
const SAFE_CATEGORIES = new Set([
    'Chat Models',
    'LLMs',
    'Embeddings',
    'Prompts',
    'Output Parsers',
    'Text Splitters',
    'Retrievers',
    'Moderation',
    'Document Loaders',
    'Record Manager',
    'Vector Stores',
    'Chains',
    'Agents',
    'Memory',
    'Tools',
    'Utilities'
])

// Within those categories, the nodes that can write, post, or keep state outside this run.
const RISKY_NODES = new Set([
    // Vector store that uploads.
    'vectaraUpload',
    // Chains that post, call any API operation, or run generated queries.
    'postApiChain',
    'openApiChain',
    'sqlDatabaseChain',
    'graphCypherQAChain',
    // Creates threads and files at OpenAI.
    'openAIAssistant',
    // Custom code.
    'customFunction',
    'ifElseFunction'
])

// Memory kept by Cuttlely's own chat history. A replay uses a new chat, so these start empty and write nothing.
const SAFE_MEMORY = new Set(['bufferMemory', 'bufferWindowMemory', 'conversationSummaryMemory', 'conversationSummaryBufferMemory'])

// Tools that only look things up or compute.
const SAFE_TOOLS = new Set([
    'calculator',
    'currentDateTime',
    'retrieverTool',
    'chainTool',
    'etlRetriever',
    'jsonPathExtractor',
    'arxiv',
    'braveSearchAPI',
    'exaSearch',
    'googleCustomSearch',
    'searXNG',
    'searchAPI',
    'serpAPI',
    'serper',
    'tavilyAPI',
    'wolframAlpha',
    'requestsGet',
    'webScraperTool',
    'webBrowser'
])

const SAFE_UTILITIES = new Set(['setVariable', 'getVariable', 'stickyNote'])

// Agentflow steps that only call a model, look things up, branch or loop. A replay keeps the run in memory.
const SAFE_AGENTFLOW_STEPS = new Set([
    'startAgentflow',
    'llmAgentflow',
    'agentAgentflow',
    'conditionAgentflow',
    'conditionAgentAgentflow',
    'retrieverAgentflow',
    'directReplyAgentflow',
    'loopAgentflow',
    'iterationAgentflow',
    'stickyNoteAgentflow'
])
// Not safe: customFunctionAgentflow (code), httpAgentflow (any request), executeFlowAgentflow (runs another flow
// for real), humanInputAgentflow (waits for a person), and toolAgentflow unless its tool is a safe one.

export interface RiskyStep {
    id: string
    label: string
}

interface CanvasNode {
    id?: string
    data?: { id?: string; name?: string; label?: string; category?: string; inputs?: Record<string, any> }
}

// The tools an agentflow Agent may call, and whether any of them waits for a person to approve it.
// A list saved as JSON text is read too; anything else that is not empty counts as an unknown tool.
function agentTools(inputs: Record<string, any> | undefined): { names: string[]; asksPerson: boolean } {
    let raw = inputs?.agentTools
    if (typeof raw === 'string') {
        try {
            raw = raw.trim() ? JSON.parse(raw) : []
        } catch {
            return { names: [''], asksPerson: false }
        }
    }
    if (raw == null || raw === '') raw = []
    if (!Array.isArray(raw)) return { names: [''], asksPerson: false }
    return {
        names: raw.map((tool: any) => String(tool?.agentSelectedTool || '')),
        asksPerson: raw.some((tool: any) => tool?.agentSelectedToolRequiresHumanInput === true)
    }
}

// The tool a Tool step runs, with the same precedence as the step itself: the older selectedTool field first.
function toolStepTool(inputs: Record<string, any> | undefined): string {
    return String(inputs?.selectedTool || inputs?.toolAgentflowSelectedTool || '')
}

const HARNESS_ACTING: Array<[string, string]> = [
    ['enableShell', 'Shell'],
    ['enableBrowser', 'Browser'],
    ['enableCodeExecution', 'Code execution'],
    ['enableFileAccess', 'Files']
]

function flagOn(value: unknown): boolean {
    return value === true || value === 'true'
}

// The Assets preset turns on code execution and files (packages/harness/presets.mjs).
const PRESET_ACTING: Record<string, string[]> = { assets: ['enableCodeExecution', 'enableFileAccess'] }

// Shell, browser, code and files can change something outside the answer. A specialist without them only
// uses the tools connected on the canvas, and those nodes are listed on their own.
export function harnessActingLabels(inputs?: Record<string, any>): string[] {
    const presetKey = typeof inputs?.preset === 'string' ? inputs.preset.trim().toLowerCase() : ''
    const preset = Object.hasOwn(PRESET_ACTING, presetKey) ? PRESET_ACTING[presetKey] : []
    return HARNESS_ACTING.filter(([key]) => flagOn(inputs?.[key]) || preset.includes(key)).map(([, label]) => label)
}

export function isRiskyNode(name: string, category: string, inputs?: Record<string, any>): boolean {
    if (!name) return true
    if (name === 'stickyNote') return false
    if (name === 'harnessChief') return false
    if (name === 'harnessSpecialist') return harnessActingLabels(inputs).length > 0
    if (name === 'toolAgentflow') return !SAFE_TOOLS.has(toolStepTool(inputs))
    if (name === 'agentAgentflow') {
        const tools = agentTools(inputs)
        return tools.asksPerson || tools.names.some((tool) => !SAFE_TOOLS.has(tool))
    }
    if (name.endsWith('Agentflow')) return !SAFE_AGENTFLOW_STEPS.has(name)
    if (!SAFE_CATEGORIES.has(category)) return true
    if (RISKY_NODES.has(name)) return true
    if (category === 'Memory') return !SAFE_MEMORY.has(name)
    if (category === 'Tools') return !SAFE_TOOLS.has(name)
    if (category === 'Utilities') return !SAFE_UTILITIES.has(name)
    return false
}

function nodesOf(flowData: string): CanvasNode[] {
    try {
        const parsed = JSON.parse(flowData)
        return Array.isArray(parsed?.nodes) ? parsed.nodes : []
    } catch {
        return []
    }
}

function postProcessingOn(chatbotConfig?: string | null): boolean {
    if (!chatbotConfig) return false
    try {
        return JSON.parse(chatbotConfig)?.postProcessing?.enabled === true
    } catch {
        return false
    }
}

// Risky steps in either canvas, once each, in canvas order. Post-processing code in the flow's settings counts too.
export function riskySteps(canvases: string[], chatbotConfig?: string | null): RiskyStep[] {
    const seen = new Set<string>()
    const steps: RiskyStep[] = []
    for (const flowData of canvases) {
        for (const node of nodesOf(flowData)) {
            const data = node.data || {}
            const name = String(data.name || '')
            if (!isRiskyNode(name, String(data.category || ''), data.inputs)) continue
            const id = String(node.id || data.id || name)
            if (seen.has(id)) continue
            seen.add(id)
            const acting = name === 'harnessSpecialist' ? harnessActingLabels(data.inputs) : []
            const who = String(data.inputs?.specialistName || data.label || name || id)
            const label = acting.length ? `${who} (${acting.join(', ')})` : String(data.label || name || id)
            steps.push({ id, label })
        }
    }
    if (postProcessingOn(chatbotConfig)) steps.push({ id: 'postProcessing', label: 'Post-processing code' })
    return steps
}
