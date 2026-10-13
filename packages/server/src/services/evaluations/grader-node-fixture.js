// A stand-in chat model for the grader node test. It records the inputs createLLM built.
class GraderNode {
    async init(nodeData) {
        GraderNode.last = nodeData
        return { ready: true }
    }
}

GraderNode.last = null

module.exports = { nodeClass: GraderNode }
