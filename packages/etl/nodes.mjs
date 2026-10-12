import { freshNodeInstance } from '@cuttlely/harness/bridge.mjs'
import { flowiseNodeOptions } from '@cuttlely/harness/credential-store.mjs'

// The server passes one shared NodesPool object per node name. Chat flows and the harness
// construct a new class from its filePath on every run. An offline check stub has no filePath
// and is used as given, because there is no class to construct.
export async function nodeInstance(nodeName, ctx = {}) {
    const registered = ctx.componentNodes?.[nodeName]
    if (registered?.filePath) return freshNodeInstance(nodeName, ctx)
    if (registered) return registered
    return freshNodeInstance(nodeName, ctx)
}

export function flowOptions(ctx = {}) {
    return { ...(ctx.flowOptions || flowiseNodeOptions()) }
}

// Runs the Flowise node's own init, so credentials, inputs and provider behaviour stay exactly as on a chat flow.
export async function initNode(spec, { inputs = {}, output, ctx = {} } = {}) {
    const instance = await nodeInstance(spec.nodeName, ctx)
    const nodeData = {
        id: spec.nodeId,
        name: spec.nodeName,
        label: spec.label,
        category: spec.category,
        inputs: { ...(spec.inputs || {}), ...inputs },
        outputs: output ? { output } : {},
        ...(spec.credential ? { credential: spec.credential } : {})
    }
    return instance.init(nodeData, '', flowOptions(ctx))
}
