// A local model that can hold a specific ticket at the provider boundary.
// Continuation reads a prior assistant message from the actual owner-scoped prompt.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const load = Module._load
const answer = (content) => ({ content, usage_metadata: { input_tokens: 8, output_tokens: 4 } })
Module._load = function (request, parent) {
    const lib = load.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_TICKET_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                return {
                    async invoke(messages) {
                        const last = messages.at(-1)
                        if (last._getType() === 'tool') {
                            assert.ok(['51', 'Checked 51'].includes(last.content))
                            return answer('Checked 51')
                        }
                        const input = String(last.content)
                        if (input.includes('Calculate')) {
                            const chief = tools.some((tool) => tool.function.name === 'run_specialist')
                            assert.ok(chief || tools.some((tool) => tool.function.name === 'calculator'))
                            return {
                                ...answer(''),
                                tool_calls: [
                                    {
                                        name: chief ? 'run_specialist' : 'calculator',
                                        id: 'checked-sum',
                                        args: chief ? { name: 'math', task: 'Calculate 17 * 3.' } : { input: '17 * 3' }
                                    }
                                ]
                            }
                        }
                        const ticket = input.match(/TKT-\d{3}/)?.[0]
                        assert.ok(ticket)
                        if (input.includes('Look up')) {
                            // Try-scoped published chats receive only their verified prior prompt messages.
                            assert.ok(!tools.some((t) => t.function.name === 'session_search'))
                            const owned = messages.some((m) => m._getType() === 'ai' && m.content === 'Receipt ' + ticket)
                            return answer(owned ? 'Recovered ' + ticket : 'No prior ticket')
                        }
                        const root = process.env.KRAKEN_TICKET_DIR
                        const hold = path.join(root, ticket + '.hold')
                        fs.writeFileSync(path.join(root, ticket + '.entered'), '')
                        while (fs.existsSync(hold)) await new Promise((resolve) => setTimeout(resolve, 15))
                        if (input.includes('Decline')) throw new Error('Fixture provider declined this ticket.')
                        return answer('Receipt ' + ticket)
                    }
                }
            }
            async invoke() {
                return answer('Ticket')
            }
        }
    }
}
