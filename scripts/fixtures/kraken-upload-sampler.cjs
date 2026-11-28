const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const { setTimeout: delay } = require('node:timers/promises')
const original = Module._load
const answer = 'North 19.00 from two observations; South 13.50 from one.'
const otherAnswer = 'West 28.00 from one observation.'
const rowTask = 'Aggregate the units from the verified rows.'
const rowCode =
    'import csv\nwith open("uploads/sales.csv", "r", newline="", encoding="utf-8") as f:\n    rows = list(csv.DictReader(f))\nunits = []\nfor row in rows:\n    units.append(int(row["units"]))\nprint(sum(units), len(rows))'
const exportTask = 'Export the uploaded rows as an ordered CSV.'
const exportCode = [
    'import csv',
    'rows = list(csv.DictReader(open("uploads/orders.csv")))',
    'data = [{"Reference": r["item"], "Units": r["units"]} for r in rows]',
    'with open("output/orders.csv", "w", newline="") as target:',
    '    writer = csv.DictWriter(target, fieldnames=["Units", "Reference"])',
    '    writer.writeheader()',
    '    writer.writerows(data)'
].join('\n')
const text = (content) => ({ content, response_metadata: { tokenUsage: { promptTokens: 12, completionTokens: 5 } } })
const terminalCommands = ['wc -c', 'wc -l', 'head -n 2', 'tail -n 2']
async function inspectUpload(messages) {
    if (process.env.KRAKEN_UPLOAD_HOLD && fs.existsSync(process.env.KRAKEN_UPLOAD_HOLD)) {
        fs.writeFileSync(process.env.KRAKEN_UPLOAD_HOLD + '.ready', '')
        const end = Date.now() + 15000
        while (fs.existsSync(process.env.KRAKEN_UPLOAD_HOLD) && Date.now() < end) await delay(25)
    }
    const received = messages.filter((message) => message._getType() === 'tool').map((message) => JSON.parse(message.content))
    for (const value of received) {
        assert.deepEqual(Object.keys(value).sort(), ['error', 'exit_code', 'output'])
        assert.equal(value.exit_code, 0)
        assert.equal(value.error, null)
    }
    if (received.length < terminalCommands.length) {
        const command = terminalCommands[received.length] + ' uploads/sales.csv'
        return { ...text(''), tool_calls: [{ name: 'terminal', id: 'inspect-upload-' + received.length, args: { command } }] }
    }
    assert.equal(received.length, 4)
    const first = received[2].output.match(/OPEN-([a-f0-9]{8})/)[1]
    const last = received[3].output.match(/CLOSE-([a-f0-9]{8})/)[1]
    const bytes = received[0].output.match(/^(\d+) uploads\/sales\.csv$/)[1]
    const lines = received[1].output.match(/^(\d+) uploads\/sales\.csv$/)[1]
    return text('Upload inspection: ' + bytes + ' bytes, ' + lines + ' lines, ' + first + ' to ' + last)
}
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
                if (tools.length === 1 && tools[0].function.name === 'terminal')
                    return { invoke: async (messages) => inspectUpload(messages) }
                const names = tools.map((tool) => tool.function.name).sort()
                if (names.includes('write_file')) {
                    assert.ok(names.includes('execute_code'))
                    assert.ok(!names.includes('write_csv_output'))
                } else assert.deepEqual(names, ['execute_code'])
                return {
                    invoke: async (messages) => {
                        const last = messages.at(-1)
                        if (messages.some((m) => typeof m.content === 'string' && m.content.includes(exportTask))) {
                            if (last._getType() !== 'tool')
                                return { ...text(''), tool_calls: [{ name: 'execute_code', id: 'csv-writer', args: { code: exportCode } }] }
                            const packet = JSON.parse(last.content)
                            assert.equal(packet.status, 'success')
                            assert.equal(packet.output, '')
                            return text('Your CSV is ready.')
                        }
                        if (messages.some((m) => typeof m.content === 'string' && m.content.includes(rowTask))) {
                            if (last._getType() !== 'tool')
                                return {
                                    ...text(''),
                                    tool_calls: [{ name: 'execute_code', id: 'aggregate-rows', args: { code: rowCode } }]
                                }
                            const result = JSON.parse(last.content)
                            assert.equal(result.status, 'success')
                            assert.match(result.output, /^\d+ 2\n$/)
                            return text('Uploaded total ' + result.output.trim())
                        }
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
                const latest = String(messages.at(-1)?.content || '')
                if (
                    messages[0].content.startsWith('You route work for') &&
                    latest.includes('Inspect the uploaded text with counts and edge samples.')
                ) {
                    return text(
                        JSON.stringify({
                            steps: [{ specialist: 'shell', task: 'Inspect the uploaded text with counts and edge samples.' }]
                        })
                    )
                }
                if (messages[0].content.startsWith('You route work for') && latest.includes(exportTask))
                    return text(JSON.stringify({ steps: [{ specialist: 'python', task: exportTask }] }))
                const inspection = latest.match(/Upload inspection: \d+ bytes, \d+ lines, [a-f0-9]{8} to [a-f0-9]{8}/)?.[0]
                if (inspection) return text(inspection)
                if (messages[0].content.startsWith('You route work for') && String(messages.at(-1)?.content).includes(rowTask))
                    return text(JSON.stringify({ steps: [{ specialist: 'python', task: rowTask }] }))
                for (const message of messages) {
                    const result = typeof message.content === 'string' && message.content.match(/Uploaded total \d+ 2/)
                    if (result) return text(result[0])
                }
                for (const expected of [answer, otherAnswer, 'Your CSV is ready.'])
                    if (messages.some((m) => typeof m.content === 'string' && m.content.includes(expected))) return text(expected)
                return text(JSON.stringify({ steps: [{ specialist: 'python', task: 'Summarize the attached CSV by region.' }] }))
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
