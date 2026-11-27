// Simulate the saved provider only. Every specialist must use its production tool
// and receive a result before this fixture supplies its model-authored answer.
const assert = require('node:assert/strict')
const Module = require('node:module')
const original = Module._load
const opsResult = 'ops-status: allowlisted MCP tool responded'
const text = (content) => ({ content, usage_metadata: { input_tokens: 5, output_tokens: 3 } })
const call = (name, args) => ({ ...text(''), tool_calls: [{ name, args, id: 'fixture-' + name }] })
const delegate = (name, task) => call('run_specialist', { name, task })
const ticketOf = (content) => {
    const ticket = content.match(/\bT-[a-f0-9]{12}\b/)?.[0]
    assert.ok(ticket, 'The incoming business task must carry its ticket.')
    return ticket
}
const stockFrom = (content) => {
    const match = content.match(/Counted units (\d+)\./)
    assert.ok(match, 'The chief must receive the calculator result.')
    return match[1]
}
const docText = (ticket, stock) => (stock ? `${ticket},${stock},ready` : `${ticket},pending review`)
const modelText = (messages) => messages.map((m) => m.content).join('\n')
const final = (body, ticket) => {
    assert.ok(body.includes(opsResult), 'The handoff must include the real status result.')
    assert.ok(body.includes('Recorded ' + ticket), 'The handoff must include document evidence.')
    return text(`Closed ${ticket} with ${stockFrom(body)} counted units and verified status.`)
}
Module._load = function (request, parent) {
    const lib = original.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_TEAM_PROVIDER_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                const names = tools.map((tool) => tool.function?.name || tool.name).sort()
                return {
                    async invoke(messages) {
                        const last = messages.at(-1),
                            body = modelText(messages)
                        const tool = last._getType() === 'tool' ? last.tool_call_id : ''
                        const ticket = ticketOf(body)
                        if (names.includes('run_specialist')) {
                            assert.deepEqual(names, ['run_specialist', 'session_search'])
                            if (!tool) return delegate('inventory', 'Count inventory for ' + ticket)
                            if (body.includes('check incomplete handoff')) {
                                if (last.content.includes('Counted units'))
                                    return delegate('clerk', 'Prepare an empty handoff for ' + ticket)
                                assert.equal(last.content, 'Specialist "clerk" failed.')
                                return text('Counted ' + stockFrom(body) + ' units. The clerk failed.')
                            }
                            if (last.content.includes('Recorded ' + ticket)) return final(body, ticket)
                            if (last.content.includes(opsResult))
                                return delegate('clerk', `Post ${ticket} with verified units ${stockFrom(body)} and ready status.`)
                            assert.ok(last.content.includes('Counted units'))
                            return delegate('operator', 'Check dispatch readiness for ' + ticket)
                        }
                        if (names.includes('ops_status')) {
                            assert.deepEqual(names, ['ops_status'])
                            if (!tool) return call('ops_status', {})
                            assert.equal(JSON.parse(last.content)[0].text, opsResult)
                            return text(opsResult)
                        }
                        if (names.includes('calculator')) {
                            assert.deepEqual(names, ['calculator', 'skill_view', 'skills_list'])
                            if (!tool) return call('skills_list', { category: 'harness-playbooks' })
                            if (tool === 'fixture-skills_list') {
                                assert.deepEqual(
                                    JSON.parse(last.content).skills.map((s) => s.name),
                                    ['shift-formula']
                                )
                                return call('skill_view', { name: 'shift-formula' })
                            }
                            if (tool === 'fixture-skill_view') {
                                const formula = JSON.parse(last.content).content.match(/Inventory formula: (\d+ \* \d+)/)
                                assert.ok(formula)
                                return call('calculator', { input: formula[1] })
                            }
                            assert.equal(tool, 'fixture-calculator')
                            assert.match(last.content, /^\d+$/)
                            return text('Counted units ' + last.content + '.')
                        }
                        assert.deepEqual(names, ['patch', 'read_file', 'search_files', 'write_file'])
                        const filename = 'output/handoff.csv'
                        const expected = docText(ticket, body.match(/with verified units (\d+) and ready status\./)?.[1])
                        if (!tool) return call('read_file', { path: filename })
                        const result = JSON.parse(last.content)
                        if (tool === 'fixture-read_file' && messages.filter((m) => m._getType() === 'tool').length === 1) {
                            assert.ok(result.error && !result.content, 'A fresh caller chat must start with an empty handoff file.')
                            return call('write_file', { path: filename, content: expected })
                        }
                        assert.ok(!result.error, result.error)
                        if (tool === 'fixture-write_file')
                            return body.includes('Prepare an empty handoff') ? text('') : call('read_file', { path: filename })
                        assert.equal(tool, 'fixture-read_file')
                        assert.ok(result.content.includes(expected))
                        return text('Recorded ' + ticket + '.')
                    }
                }
            }
            async invoke(messages) {
                const system = String(messages[0].content),
                    body = modelText(messages)
                if (system.startsWith('You name chat sessions.')) return text('Shift reconciliation')
                const ticket = ticketOf(body)
                if (system.includes('Your specialists already did the work')) return final(body, ticket)
                return text(
                    JSON.stringify({
                        steps: [
                            { specialist: 'inventory', task: 'Count inventory for ' + ticket },
                            { specialist: 'operator', task: 'Check dispatch readiness for ' + ticket },
                            { specialist: 'clerk', task: 'Prepare an independent shift cover note for ' + ticket }
                        ]
                    })
                )
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
