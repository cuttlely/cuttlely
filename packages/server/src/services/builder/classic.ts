import { cloneDeep } from 'lodash'
import { missing, pickCredential } from './credentials'
import { Plan, PlanEdge, PlanNode } from './plan'
import { MissingCredential, PartDefinition, RecipeContext } from './recipe'

// Helpers for the classic canvases (harnesses, pipelines, chatflows): cards with plug points, where a
// connection fits only when the card's output type is one the plug accepts.

// Input types that are settings on the card, not plugs (the same list the canvas uses).
const SETTING_TYPES = new Set([
    'asyncOptions',
    'asyncMultiOptions',
    'options',
    'multiOptions',
    'array',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'tabs',
    'conditionFunction',
    'timePicker',
    'weekDaysPicker',
    'monthDaysPicker',
    'datePicker'
])

const FLOWISE_CREDENTIAL_ID = 'FLOWISE_CREDENTIAL_ID'

const typesOf = (type: unknown) =>
    String(type || '')
        .split('|')
        .map((t) => t.trim())
        .filter(Boolean)

export const plugsOf = (def: PartDefinition | undefined) => (def?.inputs || []).filter((input) => !SETTING_TYPES.has(String(input.type)))

export const settingsOf = (def: PartDefinition | undefined) => (def?.inputs || []).filter((input) => SETTING_TYPES.has(String(input.type)))

// Text settings a card cannot run without: required, with no default. A tool with an empty name, for one, makes the
// model provider refuse the whole chat.
const TEXT_TYPES = new Set(['string', 'password', 'code', 'json', 'number'])
export const requiredSettingsOf = (def: PartDefinition | undefined) =>
    settingsOf(def).filter((input) => !input.optional && input.default === undefined && TEXT_TYPES.has(String(input.type)))

// Every type a card can hand on: its own classes, or the classes of each output it can switch to.
export const outputTypesOf = (def: PartDefinition | undefined): string[] => {
    if (!def) return []
    const outputs = (def.outputs || []).flatMap((output) => (output.baseClasses as string[]) || [])
    return [...new Set([...(def.baseClasses || []), ...outputs])]
}

export const fits = (source: PartDefinition | undefined, plug: Record<string, any>) => {
    const accepts = typesOf(plug.type)
    return outputTypesOf(source).some((type) => accepts.includes(type))
}

// The plug a connection lands on: the one the plan named, or the only plug on the target its output fits.
export function plugFor(edge: PlanEdge, source: PartDefinition | undefined, target: PartDefinition | undefined) {
    const plugs = plugsOf(target)
    if (edge.input) {
        const named = plugs.find((plug) => plug.name === edge.input)
        if (!named)
            return {
                problem: `"${edge.input}" is not a plug on "${edge.to}"; its plugs are ${plugs.map((p) => p.name).join(', ') || 'none'}.`,
                unknownPlug: edge.input
            }
        if (!fits(source, named))
            return {
                problem: `"${edge.from}" (${source?.name}) does not fit the ${named.name} plug on "${edge.to}", which takes ${named.type}.`,
                misfit: named
            }
        return { plug: named }
    }
    const fitting = plugs.filter((plug) => fits(source, plug))
    if (fitting.length === 1) return { plug: fitting[0] }
    if (!fitting.length) return { problem: `"${edge.from}" (${source?.name}) does not fit any plug on "${edge.to}" (${target?.name}).` }
    return {
        problem: `Say which plug on "${edge.to}" the connection from "${edge.from}" uses: ${fitting.map((p) => p.name).join(' or ')}.`
    }
}

// The plug-type check every classic canvas shares. `filled` names plugs the recipe fills itself.
export function plugProblems(plan: Plan, ctx: RecipeContext, filled: Record<string, string[]> = {}): string[] {
    const problems: string[] = []
    const byId = new Map(plan.nodes.map((node) => [node.id, node]))
    const def = (node?: PlanNode) => (node ? ctx.componentNodes[node.name] : undefined)
    const used = new Map<string, number>()
    for (const edge of plan.edges) {
        const source = byId.get(edge.from)
        const target = byId.get(edge.to)
        if (!source || !target) continue
        const found = plugFor(edge, def(source), def(target))
        if (found.problem) {
            // Name the parts in this plan that do fit, so the repair round can connect one of them instead.
            const misfit = 'misfit' in found ? found.misfit : undefined
            const fitting = misfit ? plan.nodes.filter((node) => node.id !== edge.to && fits(def(node), misfit)) : []
            // A plug the card does not have: name parts of the same kind that do have it, so the repair can swap the card.
            const wanted = 'unknownPlug' in found ? found.unknownPlug : undefined
            const kind = def(target)?.category
            const swaps =
                wanted && kind
                    ? Object.entries(ctx.componentNodes)
                          .filter(([name, d]) => name !== target.name && d.category === kind && plugsOf(d).some((p) => p.name === wanted))
                          .map(([name]) => name)
                          .slice(0, 3)
                    : []
            problems.push(
                fitting.length
                    ? `${found.problem} In this plan, ${fitting.map((node) => `"${node.id}" (${node.name})`).join(' or ')} fits it.`
                    : swaps.length
                    ? `${found.problem} ${kind} parts with a ${wanted} plug: ${swaps.join(', ')}.`
                    : found.problem
            )
            continue
        }
        const key = `${edge.to}:${found.plug?.name}`
        used.set(key, (used.get(key) || 0) + 1)
        if (!found.plug?.list && (used.get(key) || 0) > 1)
            problems.push(`The ${found.plug?.name} plug on "${edge.to}" takes one connection; this plan gives it more.`)
    }
    for (const node of plan.nodes) {
        for (const plug of plugsOf(def(node))) {
            if (plug.optional || (filled[node.name] || []).includes(plug.name)) continue
            if (!used.get(`${node.id}:${plug.name}`))
                problems.push(`"${node.label || node.id}" (${node.name}) needs something in its ${plug.name} plug (${plug.type}).`)
        }
    }
    return problems
}

// A card as the canvas creates it (packages/ui/src/utils/genericHelper.js initNode).
export function classicCard(definition: PartDefinition, id: string) {
    const def = cloneDeep(definition)
    const inputParams: any[] = []
    const inputAnchors: any[] = []
    for (const input of def.inputs || []) {
        const entry = { ...input, id: `${id}-input-${input.name}-${input.type}` }
        if (SETTING_TYPES.has(String(input.type))) inputParams.push(entry)
        else inputAnchors.push(entry)
    }
    if (def.credential) inputParams.unshift({ ...def.credential, id: `${id}-input-${def.credential.name}-${def.credential.type}` })
    const inputs: Record<string, any> = {}
    for (const input of def.inputs || []) inputs[input.name] = input.default ?? ''
    let outputAnchors: any[]
    let outputs: Record<string, any> = {}
    if (def.hideOutput) outputAnchors = []
    else if (def.outputs?.length) {
        const options = def.outputs.map((output: any) => {
            const classes: string[] = output.baseClasses || []
            return {
                id: `${id}-output-${output.name}-${classes.join('|')}`,
                name: output.name,
                label: output.label,
                description: output.description ?? '',
                type: classes.join(' | ')
            }
        })
        outputAnchors = [{ name: 'output', label: 'Output', type: 'options', options, default: def.outputs[0].name }]
        outputs = { output: def.outputs[0].name }
    } else {
        outputAnchors = [
            {
                id: `${id}-output-${def.name}-${(def.baseClasses || []).join('|')}`,
                name: def.name,
                label: def.type,
                description: def.description ?? '',
                type: (def.baseClasses || []).join(' | ')
            }
        ]
    }
    return {
        id,
        label: def.label,
        version: def.version,
        name: def.name,
        type: def.type,
        baseClasses: def.baseClasses,
        category: def.category,
        description: def.description,
        icon: def.icon,
        inputParams,
        inputAnchors,
        inputs,
        outputAnchors,
        outputs,
        credential: '',
        selected: false
    }
}

const sourceHandleFor = (data: any, plug: Record<string, any>) => {
    const anchor = data.outputAnchors?.[0]
    if (!anchor) return undefined
    if (anchor.type !== 'options') return anchor.id
    const accepts = typesOf(plug.type)
    const option = anchor.options.find((o: any) => typesOf(o.type).some((t) => accepts.includes(t))) || anchor.options[0]
    data.outputs = { ...(data.outputs || {}), output: option.name }
    return option.id
}

// Connects source into target the way the canvas does: an edge plus a {{id.data.instance}} reference.
export function connectCards(source: any, target: any, plug: Record<string, any>) {
    const anchor = target.data.inputAnchors.find((a: any) => a.name === plug.name)
    const ref = `{{${source.id}.data.instance}}`
    const current = target.data.inputs[plug.name]
    if (anchor?.list) target.data.inputs[plug.name] = [...(Array.isArray(current) ? current : []), ref]
    else target.data.inputs[plug.name] = ref
    const sourceHandle = sourceHandleFor(source.data, plug)
    return {
        source: source.id,
        sourceHandle,
        target: target.id,
        targetHandle: anchor.id,
        type: 'buttonedge',
        id: `${source.id}-${sourceHandle}-${target.id}-${anchor.id}`
    }
}

// Cards for every plan part, with plain settings, credentials matched by name, and connections. Positions are
// left at 0; the recipe lays them out.
export function classicCanvas(
    plan: Plan,
    ctx: RecipeContext,
    setup: (node: PlanNode, data: any) => void = () => undefined
): { nodes: any[]; edges: any[]; missingCredentials: MissingCredential[]; idOf: (planId: string) => string } {
    const missingCredentials: MissingCredential[] = []
    const counters: Record<string, number> = {}
    const ids = new Map<string, string>()
    for (const node of plan.nodes) {
        const n = counters[node.name] ?? 0
        counters[node.name] = n + 1
        ids.set(node.id, `${node.name}_${n}`)
    }
    const idOf = (planId: string) => ids.get(planId) as string
    const nodes = plan.nodes.map((node) => {
        const def = ctx.componentNodes[node.name]
        const id = idOf(node.id)
        const data: any = classicCard(def, id)
        if (node.label) data.label = node.label
        const settings = new Set(settingsOf(def).map((s) => s.name))
        for (const [key, value] of Object.entries(node.inputs || {})) {
            if (!settings.has(key)) continue
            if (['string', 'number', 'boolean'].includes(typeof value)) data.inputs[key] = value
        }
        const credentialNames: string[] = def.credential?.credentialNames || []
        if (credentialNames.length) {
            const picked = pickCredential(credentialNames, node.credential, ctx.credentials)
            if (picked.id) {
                data.credential = picked.id
                data.inputs[FLOWISE_CREDENTIAL_ID] = picked.id
            } else missingCredentials.push(missing(data.label, credentialNames, node.credential, ctx.credentialLabels))
        }
        setup(node, data)
        return { id, position: { x: 0, y: 0 }, positionAbsolute: { x: 0, y: 0 }, type: 'customNode', width: 300, height: 400, data }
    })
    const byPlanId = new Map(plan.nodes.map((node, index) => [node.id, nodes[index]]))
    const planById = new Map(plan.nodes.map((node) => [node.id, node]))
    const edges = plan.edges.map((edge) => {
        const source = byPlanId.get(edge.from)
        const target = byPlanId.get(edge.to)
        const found = plugFor(edge, ctx.componentNodes[planById.get(edge.from)!.name], ctx.componentNodes[planById.get(edge.to)!.name])
        return connectCards(source, target, found.plug as Record<string, any>)
    })
    return { nodes, edges, missingCredentials, idOf }
}

// The building model as a card, with the credential the person picked.
export function modelCard(ctx: RecipeContext, id: string) {
    const def = ctx.componentNodes[ctx.chatModel.name]
    const data: any = classicCard(def, id)
    for (const [key, value] of Object.entries(ctx.chatModel.inputs || {})) data.inputs[key] = value
    if (ctx.chatModel.credential) {
        data.credential = ctx.chatModel.credential
        data.inputs[FLOWISE_CREDENTIAL_ID] = ctx.chatModel.credential
    }
    return { id, position: { x: 0, y: 0 }, positionAbsolute: { x: 0, y: 0 }, type: 'customNode', width: 300, height: 400, data }
}

export const shortText = (text: unknown, max: number) => {
    const value = String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

// A bundled classic canvas as a plan, so examples teach the same shape the model replies with.
export function classicAsPlan(
    flow: { nodes: any[]; edges: any[] },
    keepInputs: string[] = [],
    skip: (node: any) => boolean = () => false
): Plan {
    const kept = (flow.nodes || []).filter((node: any) => !skip(node))
    const keptIds = new Set(kept.map((node: any) => node.id))
    const nodes: PlanNode[] = kept.map((node: any) => {
        const data = node.data || {}
        const plan: PlanNode = { id: node.id, name: data.name }
        const inputs: Record<string, unknown> = {}
        for (const key of keepInputs) {
            const value = data.inputs?.[key]
            if (typeof value === 'string' && value && !value.startsWith('{{')) inputs[key] = shortText(value, 200)
            else if (typeof value === 'boolean' && value) inputs[key] = value
        }
        if (typeof data.inputs?.instructions === 'string' && data.inputs.instructions)
            plan.instructions = shortText(data.inputs.instructions, 240)
        delete inputs.instructions
        if (Object.keys(inputs).length) plan.inputs = inputs
        return plan
    })
    const edges: PlanEdge[] = (flow.edges || [])
        .filter((edge: any) => keptIds.has(edge.source) && keptIds.has(edge.target))
        .map((edge: any) => {
            const handle = String(edge.targetHandle || '')
            const input = handle.includes('-input-') ? handle.split('-input-')[1].split('-')[0] : undefined
            return input ? { from: edge.source, to: edge.target, input } : { from: edge.source, to: edge.target }
        })
    return { nodes, edges, starterQuestions: [] }
}
