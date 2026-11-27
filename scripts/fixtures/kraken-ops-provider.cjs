// Replace the saved ChatXAI provider client after the node resolves its encrypted test credential.
// Both the protocol server and the application/worker stay real.
const assert = require('node:assert/strict')
const Module = require('node:module')
const original = Module._load
const evidence = 'ops-status: allowlisted MCP tool responded'
function answer(content) {
    return { content, usage_metadata: { input_tokens: 7, output_tokens: 4 } }
}
Module._load = function (request, parent) {
    const lib = original.apply(this, arguments)
    if (request === '@modelcontextprotocol/sdk/client/index.js' && process.env.KRAKEN_OPS_LATCH) {
        const fs = require('node:fs')
        const marker = process.env.KRAKEN_OPS_LATCH
        return {
            ...lib,
            Client: class extends lib.Client {
                async callTool(...args) {
                    const result = await super.callTool(...args)
                    if (fs.existsSync(marker)) {
                        fs.appendFileSync(marker + '.received', 'one response\n')
                        while (fs.existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 25))
                    }
                    return result
                }
            }
        }
    }
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_OPS_MODEL_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                const names = tools.map((tool) => tool.function.name)
                return {
                    async invoke(messages) {
                        const last = messages.at(-1)
                        if (names.includes('run_specialist')) {
                            if (last._getType() === 'tool') {
                                assert.ok(last.content.includes(evidence))
                                return answer(last.content)
                            }
                            return {
                                ...answer(''),
                                tool_calls: [
                                    {
                                        name: 'run_specialist',
                                        id: 'qa-delegate',
                                        args: { name: 'operator', task: 'Read the current ops status.' }
                                    }
                                ]
                            }
                        }
                        assert.deepEqual(names, ['ops_status'])
                        if (last._getType() === 'tool') {
                            const [result] = JSON.parse(last.content)
                            assert.deepEqual(result, { type: 'text', text: evidence })
                            return answer(result.text)
                        }
                        return { ...answer(''), tool_calls: [{ name: 'ops_status', id: 'qa-ops', args: {} }] }
                    }
                }
            }
            async invoke(messages) {
                if (String(messages[0]?.content).startsWith('You name chat sessions.')) return answer('Ops status')
                assert.ok(
                    messages.some((message) => String(message.content).includes(evidence)),
                    'Handoff requires actual specialist evidence'
                )
                return answer(evidence)
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
const localFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input.href)
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return localFetch(input, init)
}
