const assert = require('node:assert/strict')
const Module = require('node:module')
const original = Module._load
const answer = 'North 19.00 from two observations; South 13.50 from one.'
const otherAnswer = 'West 28.00 from one observation.'
const text = (content) => ({ content, response_metadata: { tokenUsage: { promptTokens: 12, completionTokens: 5 } } })
Module._load = function (name, parent) {
    const lib = Reflect.apply(original, this, arguments)
    if (name !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_SAMPLE_MODEL)
                super(id, fields)
            }
            bindTools(tools) {
                assert.deepEqual(
                    tools.map((t) => t.function.name),
                    ['execute_code']
                )
                return {
                    invoke: async (messages) => {
                        const last = messages.at(-1)
                        if (last._getType() === 'tool') {
                            const res = JSON.parse(last.content)
                            assert.equal(res.status, 'success')
                            if (res.output.includes('West: sum=28.00 mean=28.00 n=1')) {
                                assert(!res.output.includes('North'))
                                return text(otherAnswer)
                            }
                            assert.match(res.output, /North: sum=19\.00 mean=9\.50 n=2/)
                            assert.match(res.output, /South: sum=13\.50 mean=13\.50 n=1/)
                            assert.match(res.output, /size_bytes=\d+\nrow_count=3/)
                            assert.match(res.output, /first_5_rows:.*last_5_rows:/s)
                            assert(!res.output.includes('/tmp/'))
                            return text(answer)
                        }
                        const code =
                            'import subprocess\nprint(subprocess.check_output(["python", "uploads/sample_csv.py", "uploads/sales.csv"], text=True), end="")'
                        return { ...text(''), tool_calls: [{ name: 'execute_code', id: 'sample-csv', args: { code } }] }
                    }
                }
            }
            async invoke(messages) {
                if (messages[0].content.startsWith('You name chat sessions.')) return text('Sample')
                for (const expected of [answer, otherAnswer])
                    if (messages.some((m) => typeof m.content === 'string' && m.content.includes(expected))) return text(expected)
                return text(JSON.stringify({ steps: [{ specialist: 'python', task: 'Summarize the attached CSV by region.' }] }))
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
