// Simulate only model transport. The specialist must recover the marker via the actual file tool.
const assert = require('node:assert/strict')
const Module = require('node:module')
const original = Module._load
const text = (content) => ({ content, usage_metadata: { input_tokens: 4, output_tokens: 3 } })
const call = (name, args) => ({ ...text(''), tool_calls: [{ id: 'fixture-' + name, name, args }] })
Module._load = function (request, parent) {
    const lib = original.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            bindTools(tools) {
                return {
                    async invoke(messages) {
                        const last = messages.at(-1)
                        if (tools.some((t) => t.function.name === 'run_specialist'))
                            return last._getType() === 'tool'
                                ? text(String(last.content))
                                : call('run_specialist', { name: 'math', task: 'Read the signed handbook.' })
                        assert.ok(tools.some((t) => t.function.name === 'skill_view'))
                        if (last._getType() !== 'tool') return call('skill_view', { name: 'handbook', file_path: 'references/rules.md' })
                        const page = JSON.parse(last.content)
                        assert.equal(page.success, true)
                        assert.match(page.content, /^Stock rule [a-f0-9-]+$/)
                        return text(page.content)
                    }
                }
            }
            async invoke(messages) {
                if (messages[0]?.content?.startsWith('You name chat sessions.')) return text('Stock rules')
                return text(JSON.stringify({ steps: [{ specialist: 'math', task: 'Read the signed handbook.' }] }))
            }
        }
    }
}
