// Simulate only the provider. The published canvas resolves its credential and runs its own retrieval nodes.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')

function respond(tools, messages) {
    const names = tools.map((tool) => tool.function?.name || tool.name)
    const system = String(messages[0]?.content)
    const visible = messages.map((message) => String(message.content)).join('\n')
    const last = messages.at(-1)
    // Count only the actual tool message delivered to the model, never its prompt or a direct model answer.
    if (last?._getType?.() === 'tool') {
        const content = String(last.content)
        if (names.includes('In-Memory_Vector_Store') && content.includes('Local Hash Embeddings built the vectors'))
            fs.appendFileSync(process.env.KRAKEN_RESEARCH_CALLS, 'staff-source\n')
        if (names.includes('Custom_Retriever') && content.includes('09:00 UTC')) {
            const receipt = content.includes('Source: Research Handbook') ? 'research-source' : 'research-raw'
            fs.appendFileSync(process.env.KRAKEN_RESEARCH_CALLS, receipt + '\n')
        }
    }
    const question = /archive/i.test(visible)
        ? 'When does the example archive open?'
        : 'Which embeddings built the vectors in the sample note?'
    const call = (name, args) => ({ content: '', tool_calls: [{ name, args, id: randomUUID() }] })
    if (system.startsWith('You name chat sessions.')) return { content: 'Local research' }
    if (system.includes('You route work for')) return { content: JSON.stringify({ steps: [{ specialist: 'researcher', task: question }] }) }
    if (last?._getType?.() === 'tool' || !names.length) {
        const evidence = last?._getType?.() === 'tool' ? String(last.content) : visible
        if (evidence.includes('09:00 UTC'))
            return { content: evidence.includes('Source: Research Handbook') ? '09:00 UTC. Source: Research Handbook.' : '09:00 UTC.' }
        if (visible.includes('Local Hash Embeddings built the vectors')) return { content: 'Local Hash Embeddings built the vectors.' }
    }
    if (names.includes('run_specialist')) return call('run_specialist', { name: 'researcher', task: question })
    const name = names.find((n) => ['Custom_Retriever', 'In-Memory_Vector_Store'].includes(n))
    if (name) return call(name, { input: question })
    return { content: 'No retrieved evidence.' }
}
const load = Module._load
Module._load = function (request, parent) {
    const value = load.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return value
    return {
        ...value,
        ChatXAI: class extends value.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_FIXTURE_MODEL_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                return { invoke: (messages) => this.reply(tools, messages) }
            }
            reply(tools, messages) {
                fs.appendFileSync(process.env.KRAKEN_RESEARCH_CALLS, '1\n')
                return respond(tools, messages)
            }
            async invoke(messages) {
                return this.reply([], messages)
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
