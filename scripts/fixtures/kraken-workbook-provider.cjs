const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const original = Module._load
function observed(value) {
    if (process.env.KRAKEN_WORKBOOK_STAGES) fs.appendFileSync(process.env.KRAKEN_WORKBOOK_STAGES, value + '\n')
}
const answer = (v) => ({ content: v, usage_metadata: { input_tokens: 12, output_tokens: 5 } })
Module._load = function (name, parent) {
    const lib = Reflect.apply(original, this, arguments)
    if (name !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    const scoped = Module.createRequire(parent.filename)
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_WORKBOOK_MODEL)
                super(id, fields)
            }
            bindTools(tools) {
                if (tools.length === 1 && typeof tools[0].invoke === 'function') {
                    const { RunnableLambda } = scoped('@langchain/core/runnables')
                    const { AIMessage } = scoped('@langchain/core/messages')
                    const tool = tools[0]
                    return RunnableLambda.from(async (input) => {
                        const messages = Array.isArray(input) ? input : input.toChatMessages()
                        if (messages.at(-1)?._getType() === 'tool') return new AIMessage(messages.at(-1).content)
                        observed('outer-tool')
                        return new AIMessage({
                            content: '',
                            tool_calls: [
                                {
                                    name: tool.name,
                                    id: 'qa-workbook-harness',
                                    args: { input: 'Sample the attached workbook.' },
                                    type: 'tool_call'
                                }
                            ]
                        })
                    })
                }
                const offered = tools.map((t) => t.function?.name).sort()
                assert(offered.includes('execute_code'))
                if (!offered.includes('sample_workbook'))
                    return {
                        invoke: async () => ({
                            ...answer(''),
                            tool_calls: [{ name: 'execute_code', id: 'unproved', args: { code: 'print("workbook unavailable")' } }]
                        })
                    }
                const source = tools.find((t) => t.function.name === 'sample_workbook').function.parameters.properties.source.enum
                assert.deepEqual(source, ['uploads/book.xlsx'])
                return {
                    invoke: async (messages) => {
                        const last = messages.at(-1)
                        if (last._getType() !== 'tool') {
                            observed('workbook-call')
                            return {
                                ...answer(''),
                                tool_calls: [{ name: 'sample_workbook', id: 'qa-first-sheet', args: { source: source[0] } }]
                            }
                        }
                        const r = JSON.parse(last.content)
                        assert.deepEqual(r.sheets, ['Sales', 'Notes'])
                        assert.equal(r.sheet, 'Sales')
                        assert.deepEqual(r.headers, ['region', 'amount', 'note'])
                        assert(!last.content.includes('PRIVATE-HIDDEN-VALUE') && last.content.length <= 4000)
                        let proof
                        if (r.aggregate.value === '28.00' || r.aggregate.value === '28') {
                            // Count and final row independently disambiguate the two samples.
                            assert.equal(r.row_count, 7)
                            assert.deepEqual(r.first[0], ['North', '9.25', 'one'])
                            assert.deepEqual(r.last.at(-1), ['South', '4', 'last'])
                            proof = 'Sales has seven rows totalling 28.'
                        } else {
                            assert.equal(r.aggregate.value, '42')
                            assert.equal(r.row_count, 1)
                            assert.deepEqual(r.first, [['East', '42', 'only']])
                            proof = 'Sales has one row totalling 42.'
                        }
                        observed('verified-workbook-result')
                        return answer(proof)
                    }
                }
            }
            async invoke(messages) {
                const all = messages.map((m) => String(m.content)).join(' ')
                if (all.includes('The verified workbook could not be sampled.')) {
                    observed('verified-refusal')
                    return answer('Workbook could not be sampled.')
                }
                if (messages[0].content.startsWith('You name chat sessions.')) return answer('Workbook')
                if (messages.some((m) => typeof m.content === 'string' && m.content.includes('Sales has seven rows totalling 28.')))
                    return answer('Sales has seven rows totalling 28.')
                if (messages.some((m) => typeof m.content === 'string' && m.content.includes('Sales has one row totalling 42.')))
                    return answer('Sales has one row totalling 42.')
                return answer(JSON.stringify({ steps: [{ specialist: 'python', task: 'Sample the attached workbook.' }] }))
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
