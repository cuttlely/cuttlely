import { cloneDeep, omit } from 'lodash'
import { stripRawCanvasMarker } from './normalizeCanvasFlow'

// The credential input key the canvas already moves onto node.data.credential when it saves.
export const CREDENTIAL_INPUT = 'FLOWISE_CREDENTIAL_ID'

// A selected credential stays when the input key is present but empty. An import clears that key's
// value, and a later pick can land on data.credential first. A non-empty input still wins, and
// clearing both clears the credential.
export function applyCredentialInput(nodeData) {
    if (!nodeData?.inputs || !Object.prototype.hasOwnProperty.call(nodeData.inputs, CREDENTIAL_INPUT)) return nodeData
    const picked = nodeData.inputs[CREDENTIAL_INPUT]
    const selected = typeof picked === 'string' ? picked.trim() : ''
    const existing = typeof nodeData.credential === 'string' ? nodeData.credential.trim() : ''
    nodeData.credential = selected || existing || (picked ?? '')
    nodeData.inputs = omit(nodeData.inputs, [CREDENTIAL_INPUT])
    return nodeData
}

// The document handleSaveFlow persists. Draft save and a save that goes live both send this string.
export function canvasSaveDocument(instance, { workflow = false } = {}) {
    const nodes = instance.getNodes().map((node) => {
        const nodeData = applyCredentialInput(cloneDeep(node.data))
        if (!workflow) stripRawCanvasMarker(nodeData)
        node.data = workflow ? { ...nodeData, selected: false, status: undefined } : { ...nodeData, selected: false }
        return node
    })
    const saved = instance.toObject()
    saved.nodes = nodes
    return saved
}
