// The plan a building model returns: parts by name, connections between them, and three starter questions.
// Every canvas recipe reads the same plan shape and turns it into its own cards.

export interface PlanNode {
    id: string
    name: string
    label?: string
    // Workflows: the iteration this node sits inside. Harnesses and chatflows do not use it.
    parent?: string
    // What the part should do, in plain words: an agent's system message, a specialist's instructions.
    instructions?: string
    // Workflows: tool names for an Agent (any number) or a Tool node (exactly one).
    tools?: string[]
    // Workflows: the routes a Condition Agent chooses between.
    scenarios?: string[]
    // Workflows: the node a Loop goes back to.
    loopBackTo?: string
    // A credential by the name it has on the Credentials page. Never a key.
    credential?: string
    // A few plain settings by input name, such as a specialist name or a folder path.
    inputs?: Record<string, unknown>
}

export interface PlanEdge {
    from: string
    to: string
    // Workflows: which route of a branching node (0 for the first).
    branch?: number
    // Harnesses, pipelines and chatflows: the plug on the target card, by input name.
    input?: string
}

export interface Plan {
    title?: string
    nodes: PlanNode[]
    edges: PlanEdge[]
    starterQuestions: string[]
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const asText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

// Pulls the JSON object out of a model reply: a fenced ```json block, or the outermost braces.
export function extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/)
    const candidates: string[] = []
    if (fenced) candidates.push(fenced[1])
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate)
        } catch {
            // try the next candidate
        }
    }
    throw new Error('The reply had no JSON plan in it.')
}

// Reads a parsed reply into a plan. Fields of the wrong type are left out here and reported by the check,
// never dropped quietly: a node without an id or name stays in the plan with empty values.
export function toPlan(raw: unknown): Plan {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const nodes = asArray<Record<string, unknown>>(value.nodes).map((node) => ({
        id: typeof node?.id === 'string' ? node.id.trim() : '',
        name: typeof node?.name === 'string' ? node.name.trim() : '',
        label: asText(node?.label),
        parent: asText(node?.parent),
        instructions: asText(node?.instructions),
        tools: Array.isArray(node?.tools) ? (node.tools as unknown[]).map((tool) => String(tool).trim()) : undefined,
        scenarios: Array.isArray(node?.scenarios) ? (node.scenarios as unknown[]).map((s) => String(s).trim()) : undefined,
        loopBackTo: asText(node?.loopBackTo),
        credential: asText(node?.credential),
        inputs:
            node?.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)
                ? (node.inputs as Record<string, unknown>)
                : undefined
    }))
    const edges = asArray<Record<string, unknown>>(value.edges).map((edge) => ({
        from: typeof edge?.from === 'string' ? edge.from.trim() : '',
        to: typeof edge?.to === 'string' ? edge.to.trim() : '',
        branch:
            typeof edge?.branch === 'number'
                ? edge.branch
                : typeof edge?.branch === 'string' && /^\d+$/.test(edge.branch.trim())
                ? Number(edge.branch)
                : undefined,
        input: asText(edge?.input)
    }))
    return {
        title: asText(value.title),
        nodes: nodes.map((node) => Object.fromEntries(Object.entries(node).filter(([, v]) => v !== undefined)) as unknown as PlanNode),
        edges: edges.map((edge) => Object.fromEntries(Object.entries(edge).filter(([, v]) => v !== undefined)) as unknown as PlanEdge),
        starterQuestions: asArray<unknown>(value.starterQuestions).map((q) => (typeof q === 'string' ? q.trim() : ''))
    }
}
