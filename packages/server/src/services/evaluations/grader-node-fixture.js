// A stand-in chat model for the grader node test. It records the inputs and options createLLM passed.
const { getCredentialData } = require('@cuttlely/components')

class GraderNode {
    async init(nodeData, _input, options) {
        GraderNode.last = nodeData
        GraderNode.lastOptions = options || null
        GraderNode.initCalls += 1
        if (GraderNode.useCredentialGate) {
            // Same call a chat model makes. A credential from another workspace throws before decrypt.
            await getCredentialData(nodeData.credential, options)
        }
        GraderNode.modelCalls += 1
        return { ready: true }
    }
}

GraderNode.last = null
GraderNode.lastOptions = null
GraderNode.initCalls = 0
GraderNode.modelCalls = 0
GraderNode.useCredentialGate = false

module.exports = { nodeClass: GraderNode }
