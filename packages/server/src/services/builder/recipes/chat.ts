import { marketplaceFlowTemplates } from '../../marketplaces/sampleTemplates'
import { estimateTemplateNodeSize, TEMPLATE_CLEARANCE } from '../../marketplaces/templateLayout'
import {
    classicAsPlan,
    classicCanvas,
    connectCards,
    fits,
    modelCard,
    outputTypesOf,
    plugProblems,
    plugsOf,
    requiredSettingsOf,
    shortText
} from '../classic'
import { closest } from '../examples'
import { layerLayout } from '../layout'
import { Plan, PlanNode } from '../plan'
import { PartDefinition, Recipe, RecipeContext } from '../recipe'

const HARNESS_TOOL = 'harness'
// The parts a chat can end on: the same categories the server's ending-node check accepts, less the ones this
// builder leaves out (multi agents, sequential agents and engines have canvases or setups of their own).
const ENDING_CATEGORIES = new Set(['Agents', 'Chains'])
// Parts whose required text settings must be filled in the plan: a tool needs its name and description, your own text
// needs the text. Prompt parts are left to their defaults, which already fit the chain they plug into.
const FILL_CATEGORIES = new Set(['Tools', 'Tools (MCP)', 'Document Loaders', 'Moderation'])
const mustFill = (part: PartDefinition | undefined) => (FILL_CATEGORIES.has(String(part?.category)) ? requiredSettingsOf(part) : [])
// The model provider takes a tool name of letters, digits, _ and - only.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const TOOL_NAME_SETTINGS = ['name', 'customToolName']
// The variables an agent or a conversation chain fills in a chat prompt.
const CHAT_PROMPT_VARIABLES = new Set(['input', 'chat_history', 'agent_scratchpad'])
const PROMPT_FIELDS = ['systemMessagePrompt', 'humanMessagePrompt']
const PART_CATEGORIES = new Set([
    'Agents',
    'Chains',
    'Memory',
    'Tools',
    'Tools (MCP)',
    'Retrievers',
    'Vector Stores',
    'Embeddings',
    'Document Loaders',
    'Text Splitters',
    'Prompts',
    'Output Parsers',
    'Moderation'
])
// The OpenAI Assistant needs an assistant made on the OpenAI side first, so the builder never picks it. The Vector
// Store Retriever only feeds a multi-retrieval chain; a retriever tool takes the vector store itself.
const LEFT_OUT = new Set(['openAIAssistant', 'vectorStoreRetriever'])
const MAX_EXAMPLES = 3
const ORIGIN = 40

const disabled = () => (process.env.DISABLED_NODES ? process.env.DISABLED_NODES.split(',') : [])
const deprecated = (part: PartDefinition) => /deprecat/i.test(String(part.badge || ''))

// The harness part is offered only when there is a saved harness to attach.
export const chatParts = (componentNodes: Record<string, PartDefinition>, harnessNames: string[] = []) =>
    Object.values(componentNodes).filter(
        (part) =>
            ((part.name === HARNESS_TOOL && harnessNames.length > 0) || PART_CATEGORIES.has(String(part.category))) &&
            !LEFT_OUT.has(part.name) &&
            !deprecated(part) &&
            !disabled().includes(part.name)
    )

export const chatRules = [
    'Exactly one chat-ready ending: an Agent or a Chain that nothing connects out of. Every other part feeds it, directly or through the part it plugs into.',
    'Do not add chat models or LLMs. The builder adds the chosen model and connects it to every part that needs a model.',
    'For an assistant that uses tools, use toolAgent with bufferMemory in its memory plug and the tools in its tools plug. For plain conversation, use conversationChain with bufferMemory.',
    'Prefer parts that need no credential unless the description names a service. To answer from your own text, put the facts in a plainText "inputs": {"text": "..."}, plug it into a memoryVectorStore document with localHashEmbeddings in its embeddings, and give the agent a retrieverTool (with "inputs": {"name": "lamp_facts", "description": "..."}; a tool name uses letters, digits, _ or - only) whose retriever is that store.',
    'When the description names a service or tool (like Tavily, Serp API, GitHub or a database), add that part even when it needs a credential. The person adds the credential afterwards.',
    `Use the ${HARNESS_TOOL} part only when the description names one of the saved harnesses listed with it; put that name in "inputs": {"harnessName": "..."}. A math, writing or study helper is not a harness.`,
    'Only connect a part to a plug whose type it gives. Name the plug with "input" when the target has more than one that fits.',
    'Put a short system message for an agent in its "inputs": {"systemMessage": "..."}.'
]

const isModel = (node: any) => ['Chat Models', 'LLMs'].includes(String(node.data?.category))
const isNote = (node: any) => node.data?.name === 'stickyNote'

// A bundled chatflow as a plan. Its models drop out, because the builder adds the chosen model itself.
export function chatSampleAsPlan(flow: { nodes: any[]; edges: any[] }): Plan {
    return classicAsPlan(
        flow,
        ['systemMessage', 'name', 'description', 'text', 'template', 'harnessName'],
        (node) => isModel(node) || isNote(node)
    )
}

// The closest of the bundled chatflows (the community ones and the stock samples). With a context, a sample that
// uses a part this builder leaves out, or would not pass the check, is skipped.
export function chatExamples(request: string, ctx?: RecipeContext) {
    const names = ctx ? new Set(chatParts(ctx.componentNodes, ctx.harnessNames).map((part) => part.name)) : null
    const samples = marketplaceFlowTemplates()
        .filter((template) => template.type === 'Chatflow')
        .map((t) => ({
            title: t.templateName,
            description: t.description,
            usecases: t.usecases || [],
            plan: chatSampleAsPlan(JSON.parse(t.flowData))
        }))
        .filter((sample) => !ctx || (sample.plan.nodes.every((node) => names!.has(node.name)) && !chatProblems(sample.plan, ctx).length))
    return closest(request, samples, (s) => [s.title, s.description, ...s.usecases].join(' '), MAX_EXAMPLES).map(
        ({ title, description, plan }) => ({ title, description, plan })
    )
}

// The plugs the chosen model fills on a part: the required ones its output fits.
const modelPlugs = (ctx: RecipeContext, def?: PartDefinition) => {
    const model = ctx.componentNodes[ctx.chatModel.name]
    return plugsOf(def).filter((plug) => !plug.optional && fits(model, plug))
}

export function chatProblems(plan: Plan, ctx: RecipeContext): string[] {
    const problems: string[] = []
    const def = (node?: PlanNode) => (node ? ctx.componentNodes[node.name] : undefined)
    for (const node of plan.nodes)
        if (['Chat Models', 'LLMs'].includes(String(def(node)?.category)))
            problems.push(`"${node.label || node.id}" (${node.name}) is a model; leave models out, the builder adds the chosen one.`)
    const endings = plan.nodes.filter((node) => !plan.edges.some((edge) => edge.from === node.id))
    if (endings.length !== 1)
        problems.push(
            `A chatflow has exactly one ending that nothing connects out of; this plan has ${endings.length}${
                endings.length ? ` (${endings.map((n) => n.id).join(', ')})` : ''
            }. Connect every other part into it.`
        )
    for (const ending of endings) {
        const category = String(def(ending)?.category || '')
        if (ending.name !== HARNESS_TOOL && !ENDING_CATEGORIES.has(category))
            problems.push(`"${ending.label || ending.id}" (${ending.name}) cannot answer a chat; end on an Agent or a Chain.`)
    }
    for (const node of plan.nodes)
        if (node.name === HARNESS_TOOL && !String(node.inputs?.harnessName || '').trim())
            problems.push(`"${node.label || node.id}" needs "inputs.harnessName", the agent team it calls.`)
        else if (node.name === HARNESS_TOOL && !(ctx.harnessNames || []).includes(String(node.inputs?.harnessName).trim()))
            problems.push(
                `"${node.label || node.id}" calls "${String(
                    node.inputs?.harnessName
                ).trim()}", which is not a saved harness. Use one of: ${(ctx.harnessNames || []).join(', ')}, or leave the harness out.`
            )
    for (const node of plan.nodes) {
        const empty = mustFill(def(node)).filter((input) => !String(node.inputs?.[input.name] ?? '').trim())
        if (empty.length)
            problems.push(
                `"${node.label || node.id}" (${node.name}) needs ${empty
                    .map((input) => `"inputs.${input.name}" (${input.label})`)
                    .join(' and ')}.`
            )
        if (FILL_CATEGORIES.has(String(def(node)?.category)))
            for (const setting of TOOL_NAME_SETTINGS) {
                const value = String(node.inputs?.[setting] ?? '').trim()
                if (value && !TOOL_NAME.test(value))
                    problems.push(
                        `"${node.label || node.id}" (${
                            node.name
                        }) "inputs.${setting}" is "${value}"; use letters, digits, _ or - only, like "lamp_facts".`
                    )
            }
        if (node.name === 'chatPromptTemplate' && plan.edges.some((edge) => edge.from === node.id)) {
            const used = PROMPT_FIELDS.flatMap((field) => [...String(node.inputs?.[field] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
            const unknown = [...new Set(used.filter((name) => !CHAT_PROMPT_VARIABLES.has(name)))]
            if (unknown.length)
                problems.push(
                    `"${node.label || node.id}" (chatPromptTemplate) uses ${unknown
                        .map((name) => `{${name}}`)
                        .join(', ')}; the chat fills only {input}. Use {input} for the person's message, or leave humanMessagePrompt out.`
                )
        }
    }
    const filled: Record<string, string[]> = {}
    for (const node of plan.nodes) filled[node.name] = modelPlugs(ctx, def(node)).map((plug) => plug.name)
    return [...problems, ...plugProblems(plan, ctx, filled)]
}

// Left to right in the order things plug in, ending on the right; the model sits in the first column.
export function chatLayout(nodes: any[], edges: any[]) {
    const size = (node: any) => estimateTemplateNodeSize(node.data)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const positions = layerLayout(
        nodes.map((node) => node.id),
        edges.map((edge) => ({ from: edge.source, to: edge.target })),
        (id) => size(byId.get(id)),
        { x0: ORIGIN, y0: ORIGIN, columnGap: TEMPLATE_CLEARANCE + 40, rowGap: TEMPLATE_CLEARANCE }
    )
    for (const node of nodes) {
        const box = size(node)
        node.position = positions[node.id]
        node.positionAbsolute = positions[node.id]
        node.width = box.width
        node.height = box.height
    }
}

export function chatCanvas(plan: Plan, ctx: RecipeContext) {
    const built = classicCanvas(plan, ctx, (node: PlanNode, data: any) => {
        if (node.instructions && 'systemMessage' in data.inputs && !data.inputs.systemMessage) data.inputs.systemMessage = node.instructions
    })
    const model = modelCard(ctx, `${ctx.chatModel.name}_0`)
    const edges = [...built.edges]
    for (const node of built.nodes) {
        for (const plug of modelPlugs(ctx, ctx.componentNodes[node.data.name])) {
            if (edges.some((edge) => edge.target === node.id && edge.targetHandle?.includes(`-input-${plug.name}-`))) continue
            edges.push(connectCards(model, node, plug as Record<string, any>))
        }
    }
    const used = edges.some((edge) => edge.source === model.id)
    const nodes = used ? [model, ...built.nodes] : built.nodes
    chatLayout(nodes, edges)
    return { nodes, edges, missingCredentials: built.missingCredentials }
}

export const chatRecipe: Recipe = {
    kind: 'chat',
    parts: (ctx) => chatParts(ctx.componentNodes, ctx.harnessNames),
    partsSummary: (ctx) => {
        const parts = chatParts(ctx.componentNodes, ctx.harnessNames)
        const describe = (part: PartDefinition) => {
            const plugs = plugsOf(part)
                .map((plug) => `${plug.name}${plug.optional ? '' : ' (required)'}: ${plug.type}`)
                .join('; ')
            return `- ${part.name}: ${part.label}. ${shortText(part.description, 80)}${part.credential ? ' (needs a credential)' : ''}${
                plugs ? ` Plugs: ${plugs}.` : ''
            }${
                mustFill(part).length
                    ? ` Fill: ${mustFill(part)
                          .map((input) => input.name)
                          .join(', ')}.`
                    : ''
            } Gives: ${outputTypesOf(part).slice(0, 4).join(', ')}${
                part.name === HARNESS_TOOL ? `. Saved harnesses: ${(ctx.harnessNames || []).join(', ')}` : ''
            }`
        }
        const groups = new Map<string, PartDefinition[]>()
        for (const part of parts) {
            const group = part.name === HARNESS_TOOL ? 'Harness' : String(part.category)
            groups.set(group, [...(groups.get(group) || []), part])
        }
        return [...groups.entries()].map(([group, list]) => `${group}:\n${list.map(describe).join('\n')}`).join('\n\n')
    },
    examples: (request, ctx) => chatExamples(request, ctx),
    rules: chatRules,
    check: chatProblems,
    materialize: chatCanvas
}
