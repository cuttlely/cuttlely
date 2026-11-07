// Offline model and retriever adapters. Production admission, runtime, queue and history stay real.
const executions = []
class ReportModel {
    async init() {
        return {
            invoke: async (messages) => {
                const system = String(messages[0]?.content || '')
                if (system.includes('You route work'))
                    return { content: JSON.stringify({ steps: [{ specialist: 'writer', task: 'Report' }] }) }
                return { content: 'Fixture report.' }
            }
        }
    }
}
class ReportRetriever {
    async init(nodeData, _input, options) {
        return {
            getRelevantDocuments: async () => {
                executions.push({ canvas: options.chatflowid, marker: nodeData.inputs.marker })
                return [{ pageContent: 'Fixture evidence.', metadata: {} }]
            }
        }
    }
}
module.exports = { nodeClass: ReportModel, ReportRetriever, executions }
