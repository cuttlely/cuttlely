import { SAVE_CALLERS, assertHarnessCaller } from './caller.mjs'
import { CHIEF_MODEL_REQUIRED, HarnessError } from './errors.mjs'
import { NODE_REF, inputNameOf, parseFlow, plainInputs } from './flow-graph.mjs'
import { compileProfileCached } from './profile.mjs'
import { specialistHandoffChars } from './context.mjs'
import { assertRosterLimits, assertSavedHarnessName, getHarness, playbookList, routingSummaryText, saveHarness } from './store.mjs'
import { toolCallingWarnings } from './tool-fallback.mjs'
import { SPECIALIST_PRESETS, presetName } from './presets.mjs'

function boolInput(value) {
    return value === true || value === 'true'
}

function isHarnessNode(node) {
    const name = node?.data?.name
    return node?.data?.category === 'Harness' || name === 'harnessChief' || name === 'harnessSpecialist'
}

function refNodeId(value) {
    return value.slice(2, value.length - '.data.instance}}'.length)
}

function nodeRefIds(value) {
    if (typeof value === 'string' && NODE_REF.test(value)) return [refNodeId(value)]
    if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && NODE_REF.test(item))) {
        return value.map(refNodeId)
    }
    return null
}

function listInputNames(componentNodes, nodeName) {
    const names = new Set()
    if (!componentNodes || !nodeName) return names
    let inputs
    try {
        inputs = componentNodes[nodeName]?.inputs
    } catch {
        return names
    }
    if (!Array.isArray(inputs)) return names
    for (const item of inputs) {
        if (item?.list && item.name) names.add(item.name)
    }
    return names
}

// seen is the path into this node, so a node shared by two branches is not a loop.
function bindingFromNode(node, flow, seen) {
    const data = node.data || {}
    const label = data.label || data.name || node.id
    if (seen.has(node.id)) {
        throw new HarnessError('bad_roster', `Wired inputs on harness "${flow.name}" form a loop at ${label}.`)
    }
    const nextSeen = new Set(seen)
    nextSeen.add(node.id)
    const rawInputs = data.inputs || {}
    const grouped = new Map()
    for (const edge of flow.edges || []) {
        if (edge.target !== node.id) continue
        const source = flow.byId[edge.source]
        if (!source || isHarnessNode(source)) continue
        if (source.data?.category === 'Chat Models' && isHarnessNode(node)) continue
        const inputName = inputNameOf(edge, source)
        if (!grouped.has(inputName)) grouped.set(inputName, [])
        grouped.get(inputName).push(source)
    }
    for (const [inputName, value] of Object.entries(rawInputs)) {
        const ids = nodeRefIds(value)
        if (!ids) continue
        const connected = new Set((grouped.get(inputName) || []).map((source) => source.id))
        if (ids.some((id) => !connected.has(id))) {
            throw new HarnessError('bad_roster', `${label} input ${inputName} points at a node that is not connected.`)
        }
    }
    const lists = listInputNames(flow.componentNodes, data.name)
    const upstream = {}
    for (const [inputName, sources] of grouped) {
        const bindings = sources.map((source) => bindingFromNode(source, flow, nextSeen))
        upstream[inputName] = lists.has(inputName) || bindings.length > 1 ? bindings : bindings[0]
    }
    return {
        nodeId: node.id,
        nodeName: data.name,
        label: data.label,
        description: data.description || '',
        category: data.category,
        inputs: plainInputs(rawInputs),
        outputs: data.outputs || {},
        ...(data.credential ? { credential: data.credential } : {}),
        ...(Object.keys(upstream).length ? { upstream } : {})
    }
}

function credentialSelected(node) {
    return typeof node?.data?.credential === 'string' && node.data.credential.trim() ? node.data.credential.trim() : ''
}

function modelBindingFromNode(node, flow, owner) {
    if (!node || node.data?.category !== 'Chat Models') return null
    const nodeName = node.data?.name
    const definition = nodeName ? flow.componentNodes?.[nodeName] : undefined
    const credentialDef = definition?.credential
    if (credentialDef && credentialDef.optional !== true && !credentialSelected(node)) {
        const label = node.data?.label || nodeName || 'chat model'
        throw new HarnessError(
            'missing_credential',
            `The ${label} chat model on ${owner} needs a credential. Select one on that node and save the harness.`
        )
    }
    return bindingFromNode(node, flow, new Set())
}

function connectedChatModels(nodeId, flow, owner) {
    let model = null
    let fallback = null
    for (const edge of flow.edges || []) {
        if (edge.target !== nodeId) continue
        const source = flow.byId[edge.source]
        const choice = modelBindingFromNode(source, flow, owner)
        if (!choice) continue
        const inputName = inputNameOf(edge, source)
        if (inputName === 'fallbackModel') fallback = choice
        else if (!model) model = choice
    }
    return { model, fallback }
}

function parseMaybeJson(value) {
    if (!value) return []
    if (Array.isArray(value)) return value
    if (typeof value === 'object') return [value]
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
        return []
    }
}

export function rosterFromFlow({ name, chatflowId, flowData, componentNodes, workspaceId }) {
    assertSavedHarnessName(name)
    const flow = parseFlow(flowData)
    const nodes = flow.nodes || []
    const edges = flow.edges || []
    const graph = {
        name,
        edges,
        byId: Object.fromEntries(nodes.map((node) => [node.id, node])),
        componentNodes
    }
    const chiefs = nodes.filter((node) => node.data?.name === 'harnessChief')
    const specialists = nodes.filter((node) => node.data?.name === 'harnessSpecialist')
    if (chiefs.length !== 1) {
        throw new HarnessError('bad_roster', `Harness "${name}" needs exactly one Harness Prime on the canvas.`)
    }
    if (specialists.length === 0) {
        throw new HarnessError('bad_roster', `Harness "${name}" needs at least one specialist on the canvas.`)
    }
    const byId = graph.byId
    const previous = getHarness(name)
    const chiefModels = connectedChatModels(chiefs[0].id, graph, 'Harness Prime')
    if (!chiefModels.model) {
        throw new HarnessError('missing_model', CHIEF_MODEL_REQUIRED)
    }
    return {
        name,
        chatflowId: chatflowId || previous?.chatflowId,
        ...(workspaceId ? { workspaceId } : {}),
        description: previous?.description || '',
        credentials: previous?.credentials,
        chief: {
            instructions: chiefs[0].data?.inputs?.instructions || '',
            model: chiefModels.model,
            ...(chiefModels.fallback ? { fallbackModel: chiefModels.fallback } : {})
        },
        specialists: specialists.map((specialist) => {
            const inputs = specialist.data?.inputs || {}
            const preset = presetName(inputs.preset)
            const specialistName = inputs.specialistName || inputs.name || (preset ? SPECIALIST_PRESETS[preset].name : '')
            if (!specialistName) {
                throw new HarnessError('bad_roster', `A specialist on harness "${name}" is missing a name.`)
            }
            const modules = []
            const mcpServers = []
            for (const edge of edges) {
                if (edge.target !== specialist.id) continue
                const source = byId[edge.source]
                if (!source || isHarnessNode(source)) continue
                if (source.data?.category === 'Chat Models') continue
                const binding = bindingFromNode(source, graph, new Set())
                if (source.data?.name === 'customMCP' || source.data?.category === 'Tools (MCP)') mcpServers.push(binding)
                else modules.push(binding)
            }
            for (const extra of parseMaybeJson(inputs.mcpServers)) mcpServers.push(extra)
            for (const extra of parseMaybeJson(inputs.modules)) modules.push(extra)
            const models = connectedChatModels(specialist.id, graph, `specialist "${specialistName}"`)
            return {
                name: specialistName,
                ...(preset ? { preset } : {}),
                instructions: inputs.instructions || '',
                ...(routingSummaryText(inputs.routingSummary) ? { summary: routingSummaryText(inputs.routingSummary) } : {}),
                ...(playbookList(inputs.playbooks).length ? { playbooks: playbookList(inputs.playbooks) } : {}),
                ...(specialistHandoffChars(inputs.handoffChars) ? { handoffChars: specialistHandoffChars(inputs.handoffChars) } : {}),
                ...(models.model ? { model: models.model } : {}),
                ...(models.fallback ? { fallbackModel: models.fallback } : {}),
                modules,
                mcpServers,
                shell: boolInput(inputs.enableShell),
                browser: boolInput(inputs.enableBrowser),
                codeExecution: boolInput(inputs.enableCodeExecution) || Boolean(preset && SPECIALIST_PRESETS[preset].codeExecution),
                fileAccess: boolInput(inputs.enableFileAccess) || Boolean(preset && SPECIALIST_PRESETS[preset].fileAccess)
            }
        })
    }
}

// A draft save checks only the record limits. A draft may still lack a model, a name or a wire that a full
// save needs, so this reads each specialist's directly wired nodes and nothing else.
export function assertFlowLimits({ name, flowData }) {
    const flow = parseFlow(flowData)
    const nodes = flow?.nodes || []
    const edges = flow?.edges || []
    const byId = Object.fromEntries(nodes.map((node) => [node?.id, node]))
    const specialists = nodes
        .filter((node) => node?.data?.name === 'harnessSpecialist')
        .map((specialist) => {
            const inputs = specialist.data?.inputs || {}
            const bindings = edges
                .filter((edge) => edge?.target === specialist.id)
                .map((edge) => byId[edge.source])
                .filter((source) => source && !isHarnessNode(source))
                .map((source) => ({
                    nodeName: source.data?.name,
                    label: source.data?.label,
                    inputs: plainInputs(source.data?.inputs || {})
                }))
            return {
                name: inputs.specialistName || inputs.name || specialist.data?.label || specialist.id,
                modules: parseMaybeJson(inputs.modules),
                mcpServers: [...bindings, ...parseMaybeJson(inputs.mcpServers)]
            }
        })
    assertRosterLimits({ name, specialists })
}

// A save names who made it, a person or an API key. A key writes only a harness on its own list.
export async function syncHarnessFromFlow(args) {
    assertHarnessCaller(args?.name, args?.caller, { allow: SAVE_CALLERS })
    const roster = rosterFromFlow(args)
    const saved = saveHarness(roster, { overwrite: true })
    compileProfileCached(saved)
    if (!args?.componentNodes && !args?.loadNode && !args?.flowOptions) return saved
    let warnings = []
    try {
        warnings = await toolCallingWarnings(saved, {
            componentNodes: args.componentNodes,
            loadNode: args.loadNode,
            flowOptions: args.flowOptions || {}
        })
    } catch (error) {
        warnings = [String(error?.message || error || 'The chat model failed to initialize.')]
    }
    for (const warning of warnings) console.warn(`[harness] ${warning}`)
    return warnings.length ? { ...saved, warnings } : saved
}
