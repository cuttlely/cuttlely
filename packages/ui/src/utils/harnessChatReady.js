// The canvas chat calls the saved chatflow. An unsaved harness has no id, so that request never starts.
// A required credential is whatever the chat-model node declares. Optional credentials (Ollama and similar) stay optional.
// Handles saved before the type suffix, and handles repaired on load, both count as a Chat Model edge.
// The same match lives in packages/harness/flow-graph.mjs chatModelEdge.

function inputNameFromHandle(edge) {
    const handle = String(edge?.targetHandle || '')
    const marker = `${edge?.target}-input-`
    if (!handle.startsWith(marker)) return ''
    return handle.slice(marker.length).split('-')[0]
}

const modelEdgeFor = (edges, chiefId) => (edges || []).find((edge) => edge?.target === chiefId && inputNameFromHandle(edge) === 'chatModel')

const credentialIdOf = (modelNode) => modelNode?.data?.credential || modelNode?.data?.inputs?.FLOWISE_CREDENTIAL_ID || ''

export function harnessChatBlock({ saved, flowReady, nodes, edges, nodeDefinitions }) {
    if (saved && !flowReady) return ''

    const nodesList = Array.isArray(nodes) ? nodes : []
    const chiefs = nodesList.filter((node) => node?.data?.name === 'harnessChief')
    const missingModel = chiefs.length === 0 || chiefs.some((chief) => !modelEdgeFor(edges, chief.id))
    const credentialGap = chiefs.some((chief) => {
        const edge = modelEdgeFor(edges, chief.id)
        if (!edge) return false
        const modelNode = nodesList.find((node) => node.id === edge.source)
        const definition = (nodeDefinitions || []).find((item) => item?.name === modelNode?.data?.name)
        if (!definition?.credential || definition.credential.optional === true) return false
        return !credentialIdOf(modelNode)
    })

    if (!saved) {
        if (missingModel) {
            return 'Save this harness before chatting. Connect a chat model to the Harness Prime and select a credential on that model. A chat model is required.'
        }
        if (credentialGap) {
            return 'Save this harness before chatting. The chat model on the Harness Prime needs a credential. Add one in Credentials and select it on that model. A chat model is required.'
        }
        return 'Save this harness before chatting.'
    }
    if (missingModel) {
        return 'Connect a chat model to the Harness Prime. A chat model is required. If that model needs a key, add it in Credentials and select it on the model, then save.'
    }
    if (credentialGap) {
        return 'The chat model on the Harness Prime needs a credential. Add one in Credentials, select it on that model, and save. A chat model is required.'
    }
    return ''
}

// Draft tries compile into a profile named try plus 8 to 32 hex characters. That shape cannot be saved.
const TRY_PROFILE_NAME = /^try[a-f0-9]{8,32}$/i

export function reservedHarnessNameMessage(name) {
    const text = String(name || '').trim()
    if (!TRY_PROFILE_NAME.test(text)) return ''
    return `Harness name "${text}" is reserved for a draft try. Choose a different name.`
}
