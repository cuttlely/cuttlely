// Only model responses are simulated. Admission, storage, the queue and managed read_file all stay real.
const assert = require('node:assert/strict')
const Module = require('node:module')
const original = Module._load
const text = (content) => ({ content, usage_metadata: { input_tokens: 4, output_tokens: 2 } })
function promptText(messages) {
    const body = messages.map((message) => message.content).join('\n')
    const privateProof = process.env.KRAKEN_PRIVATE_PROOF_CHECK
    assert.ok(!privateProof || !body.includes(privateProof), 'A private server receipt entered the model prompt.')
    assert.ok(!body.includes("proof='") && !body.includes('managedUploadReceipts'))
    return body
}
Module._load = function (request, parent) {
    const lib = original.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_INLINE_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                assert.deepEqual(tools.map((t) => t.function.name).sort(), ['patch', 'read_file', 'search_files', 'write_file'])
                return {
                    invoke: async (messages) => {
                        const last = messages.at(-1)
                        promptText(messages)
                        if (last._getType() !== 'tool')
                            return {
                                ...text(''),
                                tool_calls: [{ name: 'read_file', id: 'admitted-input', args: { path: 'uploads/catalog.csv', limit: 2 } }]
                            }
                        const result = JSON.parse(last.content)
                        if (result.error) return text('No verified catalog.')
                        assert.ok(result.content.includes('sample,19'))
                        return text('Read the admitted catalog.')
                    }
                }
            }
            async invoke(messages) {
                const body = promptText(messages)
                if (String(messages[0].content).startsWith('You name chat sessions.')) return text('Catalog')
                if (body.includes('Read the admitted catalog.')) return text('Read the admitted catalog.')
                if (body.includes('No verified catalog.')) return text('No verified catalog.')
                return text(JSON.stringify({ steps: [{ specialist: 'math', task: 'Check the uploaded catalog.' }] }))
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
