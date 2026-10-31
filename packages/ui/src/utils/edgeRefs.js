import cloneDeep from 'lodash/cloneDeep'

import { normalizeCanvasFlow, normalizeNodeData } from './normalizeCanvasFlow'

const handlesEqual = (a, b) => {
    if (a === b) return true
    const withoutClassList = (value) => {
        if (!value) return value
        const lastDash = value.lastIndexOf('-')
        if (lastDash === -1) return value
        const suffix = value.substring(lastDash + 1)
        return suffix.includes('|') ? value.substring(0, lastDash) : value
    }
    return withoutClassList(a) === withoutClassList(b)
}

const addToolRef = (values, sourceNodeId) => {
    values.push(`{{${sourceNodeId}.data.instance}}`)
    const sortKey = (item) => {
        if (item.includes('requestsGet') || item.includes('readFile')) return 0
        if (item.includes('requestsPost') || item.includes('writeFile')) return 1
        return 2
    }
    values.sort((a, b) => sortKey(a) - sortKey(b))
}

const supportedCanvas = (canvasType) => String(canvasType || 'CHATFLOW').toUpperCase() !== 'AGENTFLOW'

const displayName = (node) => node?.data?.label || node?.data?.name || node?.id || 'This node'

const inputName = (anchor) => anchor?.label || anchor?.name || 'this input'

const specsByName = (specs) => {
    if (specs instanceof Map) return specs
    const result = new Map()
    for (const spec of Array.isArray(specs) ? specs : []) {
        if (spec?.name) result.set(spec.name, spec)
    }
    return result
}

export const needsSync = (node, spec) =>
    Boolean(spec && !node?.data?.cuttlelyRawNode && (node?.data?.version == null || spec.version > node.data.version))

export const anyNeedsSync = (nodes, specs) => {
    const byName = specsByName(specs)
    return (Array.isArray(nodes) ? nodes : []).some((node) => needsSync(node, byName.get(node?.data?.name)))
}

export const stageCanvasPayload = (payload, specs) => {
    const ready = Boolean(payload && Array.isArray(specs))
    return { ready: ready ? payload : null, pending: ready ? null : payload }
}

export const fillSpecDefaults = (data, spec, edges = []) => {
    if (!data || !spec || data.cuttlelyRawNode) return data
    const next = cloneDeep(data)
    const inputs = { ...(next.inputs || {}) }

    for (const param of spec.inputs || []) {
        if (!param || !Object.prototype.hasOwnProperty.call(param, 'default')) continue
        const value = inputs[param.name]
        const emptyTypedValue = value === '' && ['number', 'boolean', 'options'].includes(param.type)
        if (value == null || emptyTypedValue) inputs[param.name] = param.default
    }
    next.inputs = inputs

    const outputs = { ...(next.outputs || {}) }
    if (outputs.output == null || outputs.output === '') {
        const outputAnchor = (next.outputAnchors || []).find((anchor) => anchor?.name === 'output' || anchor?.type === 'options')
        if (outputAnchor) {
            const outgoing = edges.find((edge) => edge?.source === next.id && edge.sourceHandle)
            const selected = outgoing && outputAnchor.options?.find((option) => handlesEqual(option.id, outgoing.sourceHandle))
            const fallback = outputAnchor.default ?? outputAnchor.options?.[0]?.name
            const value = selected?.name ?? fallback
            if (value != null) outputs.output = value
        }
    }
    next.outputs = outputs
    return next
}

export const applyEdgeRefs = (nodes, edges, options = {}) => {
    if (!supportedCanvas(options.canvasType)) return { nodes, changed: false, unmatched: [] }

    const nextNodes = Array.isArray(nodes) ? nodes.slice() : []
    const byId = new Map(nextNodes.map((node, index) => [node?.id, { node, index }]))
    const unmatched = []
    let changed = false

    for (const edge of Array.isArray(edges) ? edges : []) {
        const targetEntry = byId.get(edge?.target)
        const sourceNode = byId.get(edge?.source)?.node
        if (!targetEntry) {
            unmatched.push(`An edge from ${displayName(sourceNode)} points at a missing node. Check the connection.`)
            continue
        }

        const targetNode = targetEntry.node
        const candidates = [...(targetNode.data?.inputAnchors || []), ...(targetNode.data?.inputParams || [])]
        const anchor = candidates.find((item) => handlesEqual(item?.id, edge.targetHandle))
        if (!anchor) {
            unmatched.push(`${displayName(targetNode)} has no input for the edge from ${displayName(sourceNode)}. Check the connection.`)
            continue
        }
        if (anchor.acceptVariable) continue

        const ref = `{{${edge.source}.data.instance}}`
        const current = targetNode.data?.inputs?.[anchor.name]
        let value = current
        if (anchor.list) {
            const values = Array.isArray(current) ? current.slice() : current == null || current === '' ? [] : [current]
            if (values.includes(ref)) continue
            if (anchor.name === 'tools') addToolRef(values, edge.source)
            else values.push(ref)
            value = values
        } else if (current == null || current === '') {
            value = ref
        } else if (current !== ref && options.overwrite) {
            value = ref
        } else if (current !== ref) {
            unmatched.push(
                `${displayName(targetNode)} already uses a different node for ${inputName(anchor)}; the edge from ${displayName(
                    sourceNode
                )} was not written. Check the connection.`
            )
            continue
        } else {
            continue
        }

        const nextNode = {
            ...targetNode,
            data: {
                ...targetNode.data,
                inputs: { ...(targetNode.data?.inputs || {}), [anchor.name]: value }
            }
        }
        nextNodes[targetEntry.index] = nextNode
        byId.set(edge.target, { node: nextNode, index: targetEntry.index })
        changed = true
    }

    return { nodes: nextNodes, changed, unmatched }
}

const removedEdgeMessage = (edge, nodes, side) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (side === 'source') {
        return `Removed the edge from ${displayName(source)} to ${displayName(
            target
        )}: the output it came from is no longer on ${displayName(source)}. Connect it again.`
    }
    return `Removed the edge from ${displayName(source)} to ${displayName(target)}: the input it pointed at is no longer on ${displayName(
        target
    )}. Connect it again.`
}

const invalidEdges = (data, edges) =>
    edges.flatMap((edge) => {
        if (edge.target === data.id) {
            const inputs = [...(data.inputParams || []), ...(data.inputAnchors || [])]
            if (!inputs.some((input) => handlesEqual(input.id, edge.targetHandle))) return [{ edge, side: 'target' }]
        }
        if (edge.source === data.id && data.outputAnchors?.length) {
            const outputExists = data.outputAnchors.some((anchor) => {
                if (anchor.type === 'options') return anchor.options?.some((option) => handlesEqual(option.id, edge.sourceHandle))
                return handlesEqual(anchor.id, edge.sourceHandle)
            })
            if (!outputExists) return [{ edge, side: 'source' }]
        }
        return []
    })

const mappedNodeData = (spec, data) => {
    const next = cloneDeep(data)
    delete next.inputParams
    delete next.inputAnchors
    delete next.outputAnchors
    normalizeNodeData(next, spec)
    next.version = spec.version
    return next
}

export const healImportedFlow = (nodes, edges, specs, options = {}) => {
    if (!supportedCanvas(options.canvasType)) {
        return { nodes, edges, attention: [] }
    }

    let nextNodes = cloneDeep(Array.isArray(nodes) ? nodes : [])
    let nextEdges = cloneDeep(Array.isArray(edges) ? edges : [])
    const byName = specsByName(specs)
    const attention = []
    const removedEdges = new Set()

    nextNodes = nextNodes.map((node) => {
        const spec = byName.get(node?.data?.name)
        if (!spec || node.data?.cuttlelyRawNode) return node
        if (node.data.version != null && spec.version != null && node.data.version > spec.version) {
            attention.push(`${displayName(node)} is newer than the available node specification. Check it before saving.`)
            return node
        }
        if (!needsSync(node, spec)) return node

        const updateNodeData = options.updateNodeData || mappedNodeData
        const hadOutput = node.data?.outputs?.output != null && node.data.outputs.output !== ''
        const data = updateNodeData(cloneDeep(spec), node.data)
        if (!hadOutput && data.outputs) {
            data.outputs = { ...data.outputs }
            delete data.outputs.output
        }
        for (const { edge, side } of invalidEdges(data, nextEdges)) {
            if (removedEdges.has(edge)) continue
            removedEdges.add(edge)
            attention.push(removedEdgeMessage(edge, nextNodes, side))
        }
        return { ...node, data }
    })

    if (removedEdges.size) nextEdges = nextEdges.filter((edge) => !removedEdges.has(edge))
    nextNodes = nextNodes.map((node) => {
        const spec = byName.get(node?.data?.name)
        if (
            !spec ||
            node.data?.cuttlelyRawNode ||
            (node.data.version != null && spec.version != null && node.data.version > spec.version)
        ) {
            return node
        }
        return { ...node, data: fillSpecDefaults(node.data, spec, nextEdges) }
    })

    const refs = applyEdgeRefs(nextNodes, nextEdges, options)
    attention.push(...refs.unmatched)
    return { nodes: refs.nodes, edges: nextEdges, attention }
}

export const wizardHeal = (specs, options = {}) => {
    const byName = specsByName(specs)
    const hasFullSpec = [...byName.values()].some((spec) => spec?.version != null && Array.isArray(spec.inputs))
    return ({ nodes, edges, route }) => {
        if (!hasFullSpec) return { nodes, edges, attention: [] }
        const normalized = normalizeCanvasFlow({ nodes: cloneDeep(nodes), edges: cloneDeep(edges) }, byName)
        const canvasType = route === '/v2/agentcanvas' ? 'AGENTFLOW' : route === '/agentcanvas' ? 'MULTIAGENT' : 'CHATFLOW'
        return healImportedFlow(normalized.nodes, normalized.edges, byName, { ...options, canvasType })
    }
}
