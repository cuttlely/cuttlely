const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const Module = require('node:module')

const request = new AsyncLocalStorage()
let openRequests = 0
const emit = http.Server.prototype.emit
http.Server.prototype.emit = function (event, incoming, ...rest) {
    if (event === 'request' && incoming.method === 'POST' && incoming.url === '/api/v1/harnesses/field-contract/runs') {
        const ticket = incoming.headers['x-qa-ticket']
        if (typeof ticket === 'string' && /^(agent|router)-[a-f0-9-]{36}$/.test(ticket))
            return request.run(ticket, () => {
                record({ kind: 'arrival', open: ++openRequests })
                rest[0].once('close', () => {
                    openRequests--
                })
                return emit.call(this, event, incoming, ...rest)
            })
    }
    return emit.call(this, event, incoming, ...rest)
}
const record = (value) => fs.appendFileSync(process.env.KRAKEN_FIELD_CALLS, JSON.stringify({ ticket: request.getStore(), ...value }) + '\n')
const dns = require('node:dns/promises')
const lookup = dns.lookup.bind(dns)
dns.lookup = (host, options) =>
    host === 'httpbin.org'
        ? Promise.resolve(options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 })
        : lookup(host, options)

const load = Module._load
Module._load = function (spec, parent) {
    const value = load.apply(this, arguments)
    if (spec === 'node-fetch' && parent?.filename?.endsWith('/dist/src/httpSecurity.js')) {
        const fetchFixed = async (url, options) => {
            assert.equal(String(url), 'https://httpbin.org/json')
            assert.equal(options.method || 'GET', 'GET')
            assert.equal(Object.keys(options.headers || {}).length, 0)
            assert.ok(request.getStore())
            const reading = 'field-reading-' + randomUUID()
            record({ kind: 'get', reading })
            return new value.Response(JSON.stringify({ reading }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return Object.assign(fetchFixed, value, { default: fetchFixed })
    }
    if (spec !== './FlowiseChatXAI' || !parent?.filename?.endsWith('/ChatXAI/ChatXAI.js')) return value
    return {
        ...value,
        ChatXAI: class extends value.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_FIELD_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                return { invoke: async (messages) => complete(tools, messages) }
            }
            async invoke(messages) {
                return complete([], messages)
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}

function complete(tools, messages) {
    const definitions = tools.map((t) => t.function || t)
    const answer = { content: '', usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }
    const system = String(messages[0]?.content || '')
    if (system.startsWith('You name chat sessions.')) return { ...answer, content: 'Field reading' }
    const ticket = request.getStore()
    assert.ok(ticket)
    const role = 'api',
        task = 'Read the saved public sensor JSON.'
    const selected = definitions.find(
        (t) =>
            t.name === 'run_specialist' ||
            t.name === 'mcp__roster__run_specialist' ||
            t.name === 'httpbin_json' ||
            t.name === 'mcp__api__requestsGet'
    )
    const readings = JSON.stringify(messages.at(-1)?.content).match(/field-reading-[0-9a-f-]{36}/g)
    if (system.includes('You route work for')) answer.content = JSON.stringify({ steps: [{ specialist: role, task }] })
    else if (readings?.length) answer.content = readings.at(-1)
    else if (selected) {
        const delegate = selected.name.endsWith('run_specialist')
        if (!delegate) {
            const agent = ticket.startsWith('agent-')
            assert.equal(selected.name, agent ? 'mcp__api__requestsGet' : 'httpbin_json')
            assert.equal(
                selected.description,
                agent
                    ? 'Connected node Requests Get. Pass the request as input.'
                    : 'GET https://httpbin.org/json and return the response body.'
            )
            if (agent) {
                assert.deepEqual(selected.parameters.properties, { input: { type: 'string' }, query: { type: 'string' } })
                assert.deepEqual(selected.parameters.required || [], [])
            } else {
                assert.deepEqual(selected.parameters.properties.queryParams.additionalProperties, { type: 'string' })
                assert.equal(selected.parameters.additionalProperties, false)
            }
        }
        answer.tool_calls = [
            {
                id: randomUUID(),
                name: selected.name,
                args: delegate ? { name: role, task } : ticket.startsWith('agent-') ? { input: '{}' } : {}
            }
        ]
    } else throw Error('No saved Field Team role, tool result or grant.')
    record({ kind: 'model', tool: answer.tool_calls?.[0].name || null })
    return answer
}
