import fs from 'fs'
import path from 'path'
import { cloneDeep } from 'lodash'
import { initAgentflowNode } from '@cuttlely/components'
import { pickCredential, missing } from '../credentials'
import { layerLayout } from '../layout'
import { Plan, PlanEdge, PlanNode } from '../plan'
import { MissingCredential, PartDefinition, Recipe, RecipeContext } from '../recipe'

const FLOWISE_CREDENTIAL_ID = 'FLOWISE_CREDENTIAL_ID'
const START = 'startAgentflow'
const ITERATION = 'iterationAgentflow'
const STICKY = 'stickyNoteAgentflow'
const CONDITION_AGENT = 'conditionAgentAgentflow'
const CONDITION = 'conditionAgentflow'
const HUMAN = 'humanInputAgentflow'
const LOOP = 'loopAgentflow'
const DIRECT_REPLY = 'directReplyAgentflow'
const NOT_AS_TOOLS = ['chainTool', 'retrieverTool', 'webBrowser']
const CARD = { width: 200, height: 72 }
const CHILD_GAP = 40
const MAX_EXAMPLES = 4

const marketplaceDir = () => path.join(__dirname, '..', '..', '..', '..', 'marketplaces', 'agentflowsv2')

export const workflowParts = (componentNodes: Record<string, PartDefinition>) =>
    Object.values(componentNodes).filter((node) => node.category === 'Agent Flows')

export const workflowTools = (componentNodes: Record<string, PartDefinition>) => {
    const disabled = process.env.DISABLED_NODES ? process.env.DISABLED_NODES.split(',') : []
    return Object.values(componentNodes).filter(
        (node) => String(node.category || '').includes('Tools') && !NOT_AS_TOOLS.includes(node.name) && !disabled.includes(node.name)
    )
}

const short = (text: unknown, max: number) => {
    const value = String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

const conditionsOf = (node: PlanNode) => (Array.isArray(node.inputs?.conditions) ? (node.inputs?.conditions as any[]) : [])

// How many routes leave a part: one per scenario, one per comparison plus "else", or two for a person's answer.
const routes = (node: PlanNode) =>
    node.name === CONDITION_AGENT
        ? (node.scenarios || []).length
        : node.name === CONDITION
        ? Math.max(conditionsOf(node).length, 1) + 1
        : node.name === HUMAN
        ? 2
        : 1

// A bundled workflow as a plan, so the examples teach the same shape the model replies with.
export function workflowAsPlan(flow: { nodes: any[]; edges: any[] }): Plan {
    const messages = (inputs: any, key: string) =>
        Array.isArray(inputs?.[key]) ? inputs[key].find((m: any) => m?.role === 'system')?.content : undefined
    const nodes: PlanNode[] = (flow.nodes || []).map((node: any) => {
        const data = node.data || {}
        const inputs = data.inputs || {}
        const plan: PlanNode = { id: node.id, name: data.name, label: data.label }
        if (node.parentNode) plan.parent = node.parentNode
        const instructions =
            messages(inputs, 'agentMessages') || messages(inputs, 'llmMessages') || inputs.conditionAgentInstructions || undefined
        if (instructions) plan.instructions = short(String(instructions).replace(/<[^>]+>/g, ' '), 240)
        const tools = Array.isArray(inputs.agentTools) ? inputs.agentTools.map((t: any) => t?.agentSelectedTool).filter(Boolean) : []
        if (tools.length) plan.tools = tools
        if (inputs.toolAgentflowSelectedTool) plan.tools = [inputs.toolAgentflowSelectedTool]
        if (Array.isArray(inputs.conditionAgentScenarios))
            plan.scenarios = inputs.conditionAgentScenarios.map((s: any) => short(s?.scenario, 120))
        if (typeof inputs.loopBackToNode === 'string' && inputs.loopBackToNode) plan.loopBackTo = inputs.loopBackToNode.split('-')[0]
        if (data.name === DIRECT_REPLY && typeof inputs.directReplyMessage === 'string' && inputs.directReplyMessage)
            plan.inputs = { directReplyMessage: short(inputs.directReplyMessage.replace(/<[^>]+>/g, ' '), 160) }
        if (data.name === CONDITION && Array.isArray(inputs.conditions))
            plan.inputs = {
                conditions: inputs.conditions.map((c: any) => ({
                    type: c?.type,
                    value1: short(String(c?.value1 || '').replace(/<[^>]+>/g, ' '), 80),
                    operation: c?.operation,
                    value2: short(String(c?.value2 || '').replace(/<[^>]+>/g, ' '), 80)
                }))
            }
        return plan
    })
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const edges: PlanEdge[] = (flow.edges || []).map((edge: any) => {
        const plan: PlanEdge = { from: edge.source, to: edge.target }
        const source = byId.get(edge.source)
        const branch = String(edge.sourceHandle || '').match(/-output-(\d+)$/)
        if (source && routes(source) > 1 && branch) plan.branch = Number(branch[1])
        return plan
    })
    return { nodes, edges, starterQuestions: [] }
}

const words = (text: string) =>
    new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length > 3)
    )

// The bundled workflows most like the request, by shared words in their title, description and use cases.
export function pickExamples(request: string, dir = marketplaceDir(), max = MAX_EXAMPLES) {
    const wanted = words(request)
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.json')) : []
    const scored = files.map((file, index) => {
        const flow = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        const title = file.replace(/\.json$/, '')
        const description = String(flow.description || '')
        const text = [title, description, ...(flow.usecases || [])].join(' ')
        const score = [...words(text)].filter((word) => wanted.has(word)).length
        return { title, description, flow, score, index }
    })
    scored.sort((a, b) => b.score - a.score || a.index - b.index)
    return scored.slice(0, max).map(({ title, description, flow }) => ({ title, description, plan: workflowAsPlan(flow) }))
}

export const workflowRules = [
    `Start with exactly one ${START} part. Nothing connects into it.`,
    'Every other part has a connection into it, except parts inside an iteration, which set "parent" to the iteration part id.',
    'Use agentAgentflow for tasks that need tools or several steps, llmAgentflow for writing, summarizing, translating or sorting text.',
    'Give every agentAgentflow, llmAgentflow and conditionAgentAgentflow "instructions" in plain words.',
    `A ${CONDITION_AGENT} needs "scenarios" (two or more). Each route is a connection from it with "branch" set to the scenario number, 0 first.`,
    'A conditionAgentflow compares values without a model: put its comparisons in "inputs": {"conditions": [{"type": "string" or "number", "value1": "{{ $flow.state.name }}", "operation": "equal", "value2": "text"}]}. It has one route per comparison plus a last "else" route. Prefer a conditionAgentAgentflow for routing by meaning.',
    'A humanInputAgentflow has two routes: "branch" 0 when the person approves, "branch" 1 when they reject.',
    'Tools come only from the tool list. An agentAgentflow may list several in "tools", a toolAgentflow exactly one. Prefer tools that need no credential unless the description names a service.',
    `A ${LOOP} sets "loopBackTo" to the id of the part it goes back to. Nothing connects out of a ${LOOP} or a ${DIRECT_REPLY}.`,
    `Usually leave ${DIRECT_REPLY} out: the last agentAgentflow or llmAgentflow answers the person by itself. A ${DIRECT_REPLY} sends the answer of the one part connected into it.`,
    "Refer to another part's answer in instructions as {{ part id }}.",
    'Use ids like agentAgentflow_0, llmAgentflow_1.'
]

const definition = (ctx: RecipeContext, name: string) => ctx.componentNodes[name]

export function workflowProblems(plan: Plan, ctx: RecipeContext): string[] {
    const problems: string[] = []
    const byId = new Map(plan.nodes.map((node) => [node.id, node]))
    const toolNames = new Set(workflowTools(ctx.componentNodes).map((tool) => tool.name))
    const starts = plan.nodes.filter((node) => node.name === START)
    if (starts.length !== 1) problems.push(`A workflow needs exactly one ${START} part; this plan has ${starts.length}.`)
    const incoming = new Map<string, PlanEdge[]>()
    const outgoing = new Map<string, PlanEdge[]>()
    for (const edge of plan.edges) {
        incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge])
        outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge])
    }
    for (const node of plan.nodes) {
        const def = definition(ctx, node.name)
        const label = `"${node.label || node.id}" (${node.name})`
        if (def?.hideInput && incoming.get(node.id)?.length) problems.push(`Nothing can connect into ${label}.`)
        if (def?.hideOutput && outgoing.get(node.id)?.length) problems.push(`Nothing can connect out of ${label}.`)
        if (node.name !== START && node.name !== STICKY && !node.parent && !incoming.get(node.id)?.length)
            problems.push(`${label} has no connection into it, so it would never run.`)
        if (node.parent) {
            const parent = byId.get(node.parent)
            if (!parent || parent.name !== ITERATION)
                problems.push(`${label} sits inside "${node.parent}", which is not an iteration part.`)
        }
        if (node.name === ITERATION && !plan.nodes.some((child) => child.parent === node.id))
            problems.push(`${label} needs at least one part inside it.`)
        if (node.name === CONDITION_AGENT) {
            const scenarios = node.scenarios || []
            if (scenarios.length < 2 || scenarios.some((s) => !s))
                problems.push(`${label} needs two or more scenarios, each in a few words.`)
        }
        const count = routes(node)
        for (const edge of outgoing.get(node.id) || []) {
            if (count > 1) {
                if (edge.branch === undefined || !Number.isInteger(edge.branch) || edge.branch < 0 || edge.branch >= count)
                    problems.push(`The connection from ${label} to "${edge.to}" needs "branch" between 0 and ${count - 1}.`)
            } else if (edge.branch !== undefined && edge.branch !== 0) {
                problems.push(`${label} has one route, so its connection to "${edge.to}" cannot use branch ${edge.branch}.`)
            }
        }
        const tools = node.tools || []
        if (tools.length && node.name !== 'agentAgentflow' && node.name !== 'toolAgentflow')
            problems.push(`Only agentAgentflow and toolAgentflow parts take tools; ${label} lists some.`)
        if (node.name === 'toolAgentflow' && tools.length !== 1) problems.push(`${label} needs exactly one tool.`)
        for (const tool of tools) if (!toolNames.has(tool)) problems.push(`"${tool}" on ${label} is not a tool in the list.`)
        if (node.name === DIRECT_REPLY && (incoming.get(node.id)?.length || 0) > 1 && !node.inputs?.directReplyMessage)
            problems.push(
                `${label} has ${
                    incoming.get(node.id)?.length
                } connections into it. Give it one, or leave it out so each route's last part answers.`
            )
        if (node.name === LOOP && (!node.loopBackTo || !byId.has(node.loopBackTo) || node.loopBackTo === node.id))
            problems.push(`${label} needs "loopBackTo" set to the id of another part in the plan.`)
    }
    return problems
}

const MESSAGE_INPUT: Record<string, string> = { agentAgentflow: 'agentMessages', llmAgentflow: 'llmMessages' }

// A reference to another card's answer, written the way the canvas editor writes it.
const mention = (id: string) => `<p><span class="variable" data-type="mention" data-id="${id}" data-label="${id}">{{ ${id} }}</span> </p>`

export function workflowCanvas(plan: Plan, ctx: RecipeContext) {
    const missingCredentials: MissingCredential[] = []
    const counters: Record<string, number> = {}
    const ids = new Map<string, string>()
    for (const node of plan.nodes) {
        const n = counters[node.name] ?? 0
        counters[node.name] = n + 1
        ids.set(node.id, `${node.name}_${n}`)
    }
    const idOf = (planId: string) => ids.get(planId) as string
    // The model refers to answers by its own ids; the cards are renamed, so the references follow.
    const renameRefs = (text: string) =>
        text.replace(/{{\s*([A-Za-z0-9_-]+)\s*}}/g, (all, ref) => (ids.has(ref) ? `{{ ${idOf(ref)} }}` : all))
    const labels = new Map(plan.nodes.map((node) => [node.id, node.label || definition(ctx, node.name)?.label || node.name]))

    const children = (parentId: string) => plan.nodes.filter((node) => node.parent === parentId)
    const boxOf = (planId: string) => {
        const node = plan.nodes.find((n) => n.id === planId) as PlanNode
        if (node.name !== ITERATION) return CARD
        const count = Math.max(children(planId).length, 1)
        return { width: CHILD_GAP + count * (CARD.width + CHILD_GAP), height: 250 }
    }
    const topLevel = plan.nodes.filter((node) => !node.parent).map((node) => node.id)
    const positions = layerLayout(topLevel, plan.edges, boxOf)

    const nodes = plan.nodes.map((node) => {
        const id = idOf(node.id)
        // The card setup rewrites the copy it is given, so settings and credentials are read from the definition.
        const def = definition(ctx, node.name)
        const data: any = initAgentflowNode(cloneDeep(def), id)
        data.label = labels.get(node.id)
        const inputs = data.inputs || (data.inputs = {})
        // Every model picker gets the model that built the flow, with its credential.
        for (const param of data.inputParams || []) {
            if (param.type === 'asyncOptions' && param.loadMethod === 'listModels') {
                inputs[param.name] = ctx.chatModel.name
                inputs[`${param.name}Config`] = { ...(ctx.chatModel.inputs || {}), [param.name]: ctx.chatModel.name }
            }
        }
        // Plain settings the plan names by input name, for inputs this card has.
        const names = new Set((def?.inputs || []).map((param: any) => param.name))
        for (const [key, value] of Object.entries(node.inputs || {})) {
            if (key === 'conditions' || !names.has(key)) continue
            if (typeof value === 'string') inputs[key] = renameRefs(value)
            else if (typeof value === 'number' || typeof value === 'boolean') inputs[key] = value
        }
        const instructions = node.instructions ? renameRefs(node.instructions) : undefined
        if (instructions) {
            const key = MESSAGE_INPUT[node.name]
            if (key) inputs[key] = [{ role: 'system', content: instructions }]
            if (node.name === CONDITION_AGENT) inputs.conditionAgentInstructions = instructions
        }
        // A Direct Reply sends the answer of the card before it unless the plan set its message.
        if (node.name === DIRECT_REPLY && !inputs.directReplyMessage) {
            const before = plan.edges.find((edge) => edge.to === node.id)
            if (before) inputs.directReplyMessage = mention(idOf(before.from))
        }
        if (node.name === CONDITION_AGENT) {
            const scenarios = node.scenarios || []
            inputs.conditionAgentScenarios = scenarios.map((scenario) => ({ scenario }))
            data.outputAnchors = scenarios.map((_, index) => ({
                id: `${id}-output-${index}`,
                label: index,
                name: index,
                description: `Condition ${index}`
            }))
        }
        if (node.name === CONDITION) {
            const conditions = conditionsOf(node)
            inputs.conditions = conditions
            data.outputAnchors = [...conditions, null].map((_, index) => ({
                id: `${id}-output-${index}`,
                label: index,
                name: index,
                description: index < conditions.length ? `Condition ${index}` : 'Else'
            }))
        }
        if (node.name === LOOP && node.loopBackTo) inputs.loopBackToNode = `${idOf(node.loopBackTo)}-${labels.get(node.loopBackTo)}`
        const tools = node.tools || []
        const toolConfig = (tool: string, key: string) => {
            const config: Record<string, any> = { [key]: tool }
            const credentialNames: string[] = definition(ctx, tool)?.credential?.credentialNames || []
            if (credentialNames.length) {
                const picked = pickCredential(credentialNames, node.credential, ctx.credentials)
                if (picked.id) config[FLOWISE_CREDENTIAL_ID] = picked.id
                else
                    missingCredentials.push(
                        missing(
                            `${data.label}: ${definition(ctx, tool)?.label || tool}`,
                            credentialNames,
                            node.credential,
                            ctx.credentialLabels
                        )
                    )
            }
            return config
        }
        if (node.name === 'agentAgentflow' && tools.length)
            inputs.agentTools = tools.map((tool) => ({
                agentSelectedTool: tool,
                agentSelectedToolConfig: toolConfig(tool, 'agentSelectedTool')
            }))
        if (node.name === 'toolAgentflow' && tools.length) {
            inputs.toolAgentflowSelectedTool = tools[0]
            inputs.toolInputArgs = []
            inputs.toolAgentflowSelectedToolConfig = toolConfig(tools[0], 'toolAgentflowSelectedTool')
        }
        const credentialNames: string[] = def?.credential?.credentialNames || []
        if (credentialNames.length) {
            const picked = pickCredential(credentialNames, node.credential, ctx.credentials)
            if (picked.id) {
                data.credential = picked.id
                inputs[FLOWISE_CREDENTIAL_ID] = picked.id
            } else missingCredentials.push(missing(data.label, credentialNames, node.credential, ctx.credentialLabels))
        }
        const box = boxOf(node.id)
        let position = positions[node.id]
        if (node.parent) {
            const index = children(node.parent).findIndex((child) => child.id === node.id)
            position = { x: CHILD_GAP + index * (CARD.width + CHILD_GAP), y: 90 }
        }
        const built: any = {
            id,
            type: node.name === ITERATION ? 'iteration' : 'agentFlow',
            position,
            positionAbsolute: position,
            width: box.width,
            height: box.height,
            data
        }
        if (node.name === ITERATION) built.style = { width: box.width, height: box.height }
        if (node.parent) {
            built.parentNode = idOf(node.parent)
            built.extent = 'parent'
            const parent = positions[node.parent]
            built.positionAbsolute = { x: parent.x + position.x, y: parent.y + position.y }
        }
        return built
    })
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const planById = new Map(plan.nodes.map((node) => [node.id, node]))
    const edges = plan.edges.map((edge) => {
        const source = idOf(edge.from)
        const target = idOf(edge.to)
        const sourceNode = nodeById.get(source)
        const many = routes(planById.get(edge.from) as PlanNode) > 1
        const sourceHandle = many
            ? `${source}-output-${edge.branch ?? 0}`
            : sourceNode.data.outputAnchors?.[0]?.id || `${source}-output-${sourceNode.data.name}`
        return {
            id: `${source}-${sourceHandle}-${target}-${target}`,
            type: 'agentFlow',
            source,
            sourceHandle,
            target,
            targetHandle: target,
            data: {
                sourceColor: sourceNode.data.color,
                targetColor: nodeById.get(target)?.data?.color,
                ...(many ? { edgeLabel: String(edge.branch ?? 0) } : {}),
                isHumanInput: planById.get(edge.from)?.name === HUMAN
            }
        }
    })
    return { nodes, edges, missingCredentials }
}

export const workflowRecipe: Recipe = {
    kind: 'workflow',
    parts: (ctx) => workflowParts(ctx.componentNodes),
    partsSummary: (ctx) => {
        const parts = workflowParts(ctx.componentNodes)
            .map((part) => `- ${part.name}: ${part.label}. ${short(part.description, 140)}`)
            .join('\n')
        const tools = workflowTools(ctx.componentNodes)
            .map((tool) => `- ${tool.name}: ${short(tool.description, 90)}${tool.credential ? ' (needs a credential)' : ''}`)
            .join('\n')
        return `${parts}\n\nTools for agentAgentflow and toolAgentflow:\n${tools}`
    },
    examples: (request) => pickExamples(request),
    rules: workflowRules,
    check: workflowProblems,
    materialize: workflowCanvas
}
