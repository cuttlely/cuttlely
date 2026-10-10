import { sampleTemplates } from '../../marketplaces/sampleTemplates'
import { estimateTemplateNodeSize, TEMPLATE_CLEARANCE, TEMPLATE_COLUMN_PITCH } from '../../marketplaces/templateLayout'
import { classicAsPlan, classicCanvas, connectCards, modelCard, outputTypesOf, plugProblems, plugsOf, shortText } from '../classic'
import { closest } from '../examples'
import { Plan, PlanNode } from '../plan'
import { PartDefinition, Recipe, RecipeContext } from '../recipe'

const PRIME = 'harnessChief'
const SPECIALIST = 'harnessSpecialist'
const PART_CATEGORIES = new Set(['Tools', 'Tools (MCP)', 'Retrievers', 'Vector Stores', 'Embeddings', 'Document Loaders', 'Text Splitters'])
const ABILITIES = ['enableShell', 'enableBrowser', 'enableCodeExecution', 'enableFileAccess']
const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/
const MAX_EXAMPLES = 4
const ORIGIN = 40

const disabled = () => (process.env.DISABLED_NODES ? process.env.DISABLED_NODES.split(',') : [])
const deprecated = (part: PartDefinition) => /deprecat/i.test(String(part.badge || ''))

export const harnessParts = (componentNodes: Record<string, PartDefinition>) =>
    Object.values(componentNodes).filter(
        (part) =>
            (part.name === PRIME || part.name === SPECIALIST || PART_CATEGORIES.has(String(part.category))) &&
            !deprecated(part) &&
            !disabled().includes(part.name)
    )

export const harnessRules = [
    `Exactly one ${PRIME} (Harness Prime). Its "instructions" say how to split the work between the specialists.`,
    `One ${SPECIALIST} per role. Each has "label" (a readable title), "inputs": {"specialistName": "short-lowercase-name", "routingSummary": "what it does, in one line"} and "instructions" in plain words.`,
    `Connect every specialist to Harness Prime: {"from": "<specialist id>", "to": "<prime id>", "input": "specialists"}.`,
    'Do not add chat models. The builder connects the chosen model to Harness Prime, and every specialist uses it.',
    'Tools, retrievers and vector stores connect to the specialist that uses them with "input": "attached". A part plugged into another part (embeddings into a vector store) names that plug.',
    'Prefer parts that need no credential unless the description names a service. For searching your own text, attach a memoryVectorStore to the specialist, plug localHashEmbeddings into its embeddings and a plainText into its document, and put the facts from the description in the plainText "inputs": {"text": "..."}.',
    'When the description names a service or tool (like Tavily, Serp API, GitHub or a database), attach that part to the specialist that uses it even when it needs a credential. The person adds the credential afterwards.',
    `Abilities (${ABILITIES.join(', ')}) stay off unless the description asks for them; turn one on with "inputs": {"enableBrowser": true}.`
]

// A bundled harness as a plan. Older samples leave specialists unplugged from Prime (the roster reads every
// specialist on the canvas); the plan connects them so examples teach the shape the check asks for.
export function harnessSampleAsPlan(flow: { nodes: any[]; edges: any[] }): Plan {
    const plan = classicAsPlan(
        flow,
        ['specialistName', 'routingSummary', 'text', ...ABILITIES],
        (node) => node.data?.category === 'Chat Models'
    )
    const prime = plan.nodes.find((node) => node.name === PRIME)
    for (const specialist of plan.nodes.filter((node) => node.name === SPECIALIST)) {
        if (prime && !plan.edges.some((edge) => edge.from === specialist.id && edge.to === prime.id))
            plan.edges.push({ from: specialist.id, to: prime.id, input: 'specialists' })
    }
    return plan
}

// The closest bundled harnesses. With a context, a sample whose plan would not pass the check is skipped.
export function harnessExamples(request: string, ctx?: RecipeContext) {
    const samples = sampleTemplates()
        .filter((template) => template.type === 'Harness')
        .map((t) => ({
            title: t.templateName,
            description: t.description,
            usecases: t.usecases || [],
            plan: harnessSampleAsPlan(JSON.parse(t.flowData))
        }))
        .filter((sample) => !ctx || !harnessProblems(sample.plan, ctx).length)
    return closest(request, samples, (s) => [s.title, s.description, ...s.usecases].join(' '), MAX_EXAMPLES).map(
        ({ title, description, plan }) => ({
            title,
            description,
            plan
        })
    )
}

export function harnessProblems(plan: Plan, ctx: RecipeContext): string[] {
    const problems: string[] = []
    const primes = plan.nodes.filter((node) => node.name === PRIME)
    const specialists = plan.nodes.filter((node) => node.name === SPECIALIST)
    if (primes.length !== 1) problems.push(`A harness needs exactly one ${PRIME} (Harness Prime); this plan has ${primes.length}.`)
    if (!specialists.length) problems.push(`A harness needs at least one ${SPECIALIST}.`)
    const names = new Set<string>()
    for (const specialist of specialists) {
        const label = `"${specialist.label || specialist.id}"`
        const name = String(specialist.inputs?.specialistName || '')
        if (!NAME_RE.test(name))
            problems.push(
                `Specialist ${label} needs "inputs.specialistName": short, lowercase, starting with a letter (like "researcher").`
            )
        else if (names.has(name)) problems.push(`Two specialists are named "${name}".`)
        names.add(name)
        if (!specialist.instructions) problems.push(`Specialist ${label} needs "instructions".`)
        if (primes[0] && !plan.edges.some((edge) => edge.from === specialist.id && edge.to === primes[0].id))
            problems.push(`Specialist ${label} is not connected to Harness Prime.`)
        for (const ability of ABILITIES) {
            const value = specialist.inputs?.[ability]
            if (value !== undefined && typeof value !== 'boolean') problems.push(`"${ability}" on ${label} must be true or false.`)
        }
    }
    // Every other part must feed a specialist, directly or through the part it plugs into.
    const feeds = (id: string, seen = new Set<string>()): boolean => {
        if (seen.has(id)) return false
        seen.add(id)
        return plan.edges.some((edge) => {
            if (edge.from !== id) return false
            const target = plan.nodes.find((node) => node.id === edge.to)
            return target?.name === SPECIALIST || (target ? feeds(target.id, seen) : false)
        })
    }
    for (const node of plan.nodes) {
        if (node.name === PRIME || node.name === SPECIALIST) continue
        if (!feeds(node.id))
            problems.push(`"${node.label || node.id}" (${node.name}) does not reach a specialist, so nothing would use it.`)
    }
    return [...problems, ...plugProblems(plan, ctx, { [PRIME]: ['chatModel'] })]
}

const titleCase = (name: string) => name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Prime in the middle, specialists beside it, tools feeding each specialist from the left, the model above Prime.
export function harnessLayout(nodes: any[], edges: any[]) {
    const size = (node: any) => estimateTemplateNodeSize(node.data)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const prime = nodes.find((node) => node.data.name === PRIME)
    const model = nodes.find(
        (node) => node.data.category === 'Chat Models' && edges.some((e) => e.source === node.id && e.target === prime?.id)
    )
    const specialists = nodes.filter((node) => node.data.name === SPECIALIST)
    const placed = new Set<string>()
    const feeders = (id: string) =>
        edges
            .filter((edge) => edge.target === id)
            .map((edge) => byId.get(edge.source))
            .filter((node) => node && node !== model && node.data.name !== SPECIALIST)
    // Depth: specialists 1, their tools 2, parts plugged into those 3, and so on.
    const depth = new Map<string, number>()
    const walk = (node: any, d: number, seen: Set<string>) => {
        if (seen.has(node.id)) return
        depth.set(node.id, Math.max(depth.get(node.id) ?? 0, d))
        for (const feeder of feeders(node.id)) walk(feeder, d + 1, new Set([...seen, node.id]))
    }
    for (const specialist of specialists) walk(specialist, 1, new Set())
    const maxDepth = Math.max(1, ...depth.values())
    const columnX = (d: number) => ORIGIN + (maxDepth - d) * TEMPLATE_COLUMN_PITCH
    const place = (node: any, x: number, y: number) => {
        node.position = { x, y }
        node.positionAbsolute = { x, y }
        placed.add(node.id)
    }
    // Each column keeps the next free height, so a specialist's tools sit beside it and never overlap.
    const free = new Map<number, number>()
    const placeTree = (node: any, d: number, y: number): number => {
        const top = Math.max(y, free.get(d) ?? ORIGIN)
        place(node, columnX(d), top)
        let bottom = top + size(node).height
        free.set(d, bottom + TEMPLATE_CLEARANCE)
        let childY = top
        for (const feeder of feeders(node.id)) {
            if (placed.has(feeder.id)) continue
            const childBottom = placeTree(feeder, d + 1, childY)
            childY = childBottom + TEMPLATE_CLEARANCE
            bottom = Math.max(bottom, childBottom)
        }
        return bottom
    }
    let next = ORIGIN
    let first = ORIGIN
    let last = ORIGIN
    specialists.forEach((specialist, index) => {
        const bottom = placeTree(specialist, 1, Math.max(next, ...free.values()))
        if (index === 0) first = specialist.position.y
        last = bottom
        next = bottom + TEMPLATE_CLEARANCE
    })
    const primeX = ORIGIN + maxDepth * TEMPLATE_COLUMN_PITCH
    const modelBottom = model ? ORIGIN + size(model).height + TEMPLATE_CLEARANCE : ORIGIN
    if (model) place(model, primeX, ORIGIN)
    if (prime) place(prime, primeX, Math.max(modelBottom, Math.round((first + last) / 2 - size(prime).height / 2)))
    // A part that feeds nothing goes below everything, in the first column.
    let spare = Math.max(last, prime ? prime.position.y + size(prime).height : 0) + TEMPLATE_CLEARANCE
    for (const node of nodes) {
        if (placed.has(node.id)) continue
        place(node, ORIGIN, spare)
        spare += size(node).height + TEMPLATE_CLEARANCE
    }
    for (const node of nodes) {
        const box = size(node)
        node.width = box.width
        node.height = box.height
    }
}

export function harnessCanvas(plan: Plan, ctx: RecipeContext) {
    const built = classicCanvas(plan, ctx, (node: PlanNode, data: any) => {
        if (node.instructions && 'instructions' in data.inputs) data.inputs.instructions = node.instructions
        if (node.name === SPECIALIST) {
            if (!node.label) data.label = titleCase(String(node.inputs?.specialistName || 'Specialist'))
            for (const ability of ABILITIES) data.inputs[ability] = node.inputs?.[ability] === true
        }
    })
    const prime = built.nodes.find((node) => node.data.name === PRIME)
    const model = modelCard(ctx, `${ctx.chatModel.name}_0`)
    const chatPlug = plugsOf(ctx.componentNodes[PRIME]).find((plug) => plug.name === 'chatModel')
    const nodes = [model, ...built.nodes]
    const edges = [connectCards(model, prime, chatPlug as Record<string, any>), ...built.edges]
    harnessLayout(nodes, edges)
    return { nodes, edges, missingCredentials: built.missingCredentials }
}

export const harnessRecipe: Recipe = {
    kind: 'harness',
    parts: (ctx) => harnessParts(ctx.componentNodes),
    partsSummary: (ctx) => {
        const parts = harnessParts(ctx.componentNodes)
        const describe = (part: PartDefinition) => {
            const plugs = plugsOf(part)
                .map((plug) => `${plug.name}${plug.optional ? '' : ' (required)'}: ${plug.type}`)
                .join('; ')
            return `- ${part.name}: ${part.label}. ${shortText(part.description, 90)}${part.credential ? ' (needs a credential)' : ''}${
                plugs ? ` Plugs: ${plugs}.` : ''
            } Gives: ${outputTypesOf(part).slice(0, 4).join(', ')}`
        }
        const team = parts.filter((part) => part.name === PRIME || part.name === SPECIALIST)
        const rest = parts.filter((part) => part.name !== PRIME && part.name !== SPECIALIST)
        return `${team.map(describe).join('\n')}\n\nParts a specialist can use:\n${rest.map(describe).join('\n')}`
    },
    examples: (request, ctx) => harnessExamples(request, ctx),
    rules: harnessRules,
    check: harnessProblems,
    materialize: harnessCanvas
}
