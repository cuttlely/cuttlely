import { cloneDeep, omit } from 'lodash'
import { stripRawCanvasMarker } from './normalizeCanvasFlow'

// The credential input key the canvas already moves onto node.data.credential when it saves.
export const CREDENTIAL_INPUT = 'FLOWISE_CREDENTIAL_ID'

// The document handleSaveFlow persists. Draft save and a save that goes live both send this string.
export function canvasSaveDocument(instance, { workflow = false } = {}) {
    const nodes = instance.getNodes().map((node) => {
        const nodeData = cloneDeep(node.data)
        if (nodeData?.inputs && Object.prototype.hasOwnProperty.call(nodeData.inputs, CREDENTIAL_INPUT)) {
            nodeData.credential = nodeData.inputs[CREDENTIAL_INPUT]
            nodeData.inputs = omit(nodeData.inputs, [CREDENTIAL_INPUT])
        }
        if (!workflow) stripRawCanvasMarker(nodeData)
        node.data = workflow ? { ...nodeData, selected: false, status: undefined } : { ...nodeData, selected: false }
        return node
    })
    const saved = instance.toObject()
    saved.nodes = nodes
    return saved
}
