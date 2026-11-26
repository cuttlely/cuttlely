// The real canvas node resolves its stored credential and constructs this model.
// Replace only the provider client in the isolated API fixture.
const assert = require('node:assert/strict')
const Module = require('node:module')
const original = Module._load
Module._load = function (request, parent) {
    const value = original.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return value
    return {
        ...value,
        ChatXAI: class extends value.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_FIXTURE_MODEL_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                return {
                    async invoke(messages) {
                        const last = messages.at(-1)
                        if (tools.some((tool) => tool.function.name === 'skill_view')) {
                            const call = (name, args) => ({
                                content: '',
                                tool_calls: [{ type: 'tool_call', name, id: 'qa-' + name + (args.offset ? '-' + args.offset : ''), args }]
                            })
                            if (last._getType() !== 'tool') {
                                assert.ok(!messages.some((message) => String(message.content).includes('Inventory formula:')))
                                return call('skills_list', { category: 'harness-playbooks' })
                            }
                            if (last.tool_call_id === 'qa-skills_list') {
                                const { skills } = JSON.parse(last.content)
                                assert.deepEqual(
                                    skills.map((skill) => skill.name),
                                    ['inventory']
                                )
                                return call('skill_view', { name: skills[0].name })
                            }
                            if (last.tool_call_id?.startsWith('qa-skill_view')) {
                                const page = JSON.parse(last.content)
                                if (page.next_offset != null) return call('skill_view', { name: page.name, offset: page.next_offset })
                                assert.ok(
                                    messages.some((message) => message._getType() === 'tool' && JSON.parse(message.content).previously_read)
                                )
                                const expression = page.content.match(/Inventory formula: (.+)/)[1]
                                return call('calculator', { input: expression })
                            }
                            assert.equal(last.tool_call_id, 'qa-calculator')
                            assert.equal(last.content, '51')
                            return { content: '51' }
                        }
                        if (last._getType() === 'tool') {
                            assert.equal(last.content, '51')
                            return { content: 'Native verified 51.' }
                        }
                        const name = tools[0].function.name
                        let args
                        if (name === 'run_specialist') {
                            assert.ok(messages.some((m) => m.content === 'Legacy verified 51.'))
                            args = { name: 'math', task: '17 * 3' }
                        } else {
                            assert.equal(name, 'calculator')
                            args = { input: '17 * 3' }
                        }
                        return { content: '', tool_calls: [{ type: 'tool_call', id: 'qa-tool', name, args }] }
                    }
                }
            }
            async invoke() {
                throw new Error('Unexpected provider call in Kraken fixture.')
            }
        }
    }
}
const fetchLocal = globalThis.fetch
globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input.href)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    return fetchLocal(input, init)
}
