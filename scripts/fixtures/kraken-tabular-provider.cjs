// Only the model transport is simulated. The report tool reads the signed source and renders real artifacts.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const Module = require('node:module')
const load = Module._load
const text = (content) => ({ content, usage_metadata: { input_tokens: 10, output_tokens: 3 } })
const call = (name, args) => ({ ...text(''), tool_calls: [{ id: randomUUID(), name, args }] })
const task = 'Calculate net sales per region from the attached CSV and make a bar chart.'
Module._load = function (request, parent) {
    const value = load.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return value
    return {
        ...value,
        ChatXAI: class extends value.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_REPORT_MODEL_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                return {
                    async invoke(messages) {
                        const last = messages.at(-1)
                        const reply = last._getType() === 'tool'
                        if (tools.some((x) => x.function.name === 'run_specialist'))
                            return reply ? text('Invented turnover 9876543') : call('run_specialist', { name: 'operator', task })
                        const report = tools.find((x) => x.function.name === 'analyze_csv_report')
                        assert.ok(report, 'This saved specialist needs an admitted CSV and report grant.')
                        if (reply) {
                            const evidence = JSON.parse(last.content)
                            assert.ok(!evidence.error, evidence.error)
                            return text('Invented turnover 9876543')
                        }
                        return call(report.function.name, {
                            source: report.function.parameters.properties.source.enum[0],
                            operation: 'sum',
                            groupBy: 'Region',
                            valueColumn: 'Net',
                            order: 'descending',
                            format: 'table_and_bar_chart'
                        })
                    }
                }
            }
            async invoke(messages) {
                const first = String(messages[0]?.content || '')
                const all = messages.map((m) => String(m.content)).join('\n')
                if (first.startsWith('You name chat sessions.')) return text('Regional sales')
                if (first.includes('steps') || first.includes('choose the analyst'))
                    return text(JSON.stringify({ steps: [{ specialist: 'operator', task }] }))
                if (all.includes('Invented turnover') || all.includes('Uploaded CSV')) return text('Invented turnover 9876543')
                return text(JSON.stringify({ steps: [{ specialist: 'operator', task }] }))
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
