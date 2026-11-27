// A local model that can hold a specific ticket at the provider boundary.
// Continuation reads a prior assistant message from the actual owner-scoped prompt.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const load = Module._load
const answer = (content) => ({ content, usage_metadata: { input_tokens: 8, output_tokens: 4 } })
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (!['api.openai.com', 'api.pinecone.io', 'tickets.invalid'].includes(url.hostname)) return realFetch(input, init)
    const req = new Request(input, init)
    if (url.hostname === 'api.openai.com') {
        assert.equal(url.pathname, '/v1/embeddings')
        assert.equal(req.headers.get('authorization'), 'Bearer ' + process.env.KRAKEN_TICKET_KEY)
        const body = await req.json()
        const [, id] = String(body.input).match(/TKT-(501|502|503|504)/)
        const vector = [Number(id), 1]
        const embedding = body.encoding_format === 'base64' ? Buffer.from(new Float32Array(vector).buffer).toString('base64') : vector
        return Response.json({
            data: [{ object: 'embedding', index: 0, embedding }],
            model: body.model,
            usage: { prompt_tokens: 1, total_tokens: 1 }
        })
    }
    assert.equal(req.headers.get('api-key'), process.env.KRAKEN_TICKET_KEY)
    if (url.hostname === 'api.pinecone.io') {
        assert.equal(url.pathname, '/indexes/tickets')
        return Response.json({
            name: 'tickets',
            dimension: 2,
            metric: 'cosine',
            host: 'tickets.invalid',
            status: { ready: true, state: 'Ready' }
        })
    }
    assert.equal(url.pathname, '/query')
    const query = await req.json()
    assert.equal(query.namespace, 'catalog')
    assert.equal(query.topK, query.vector[0] >= 503 ? 5 : 1)
    const ticket = 'TKT-' + query.vector[0]
    await holdTicket(ticket)
    return Response.json({ matches: [{ id: ticket, score: 1, metadata: { text: 'Catalog receipt ' + ticket, source: ticket } }] })
}

async function holdTicket(ticket) {
    const root = process.env.KRAKEN_TICKET_DIR
    fs.writeFileSync(path.join(root, ticket + '.entered'), '')
    while (fs.existsSync(path.join(root, ticket + '.hold'))) await new Promise((r) => setTimeout(r, 15))
}
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
                        const names = tools.map((tool) => tool.function.name)
                        const ticketTask = messages.findLast((message) => message._getType() === 'human')?.content
                        const catalogTicket = String(ticketTask).match(/TKT-50[34]/)?.[0]
                        if (catalogTicket) {
                            const call = (name, args) => ({ ...answer(''), tool_calls: [{ name, args, id: name + '-request' }] })
                            if (last._getType() === 'tool' && String(last.content).includes('Catalog receipt ' + catalogTicket))
                                return answer('Catalog receipt ' + catalogTicket)
                            if (names.includes('run_specialist'))
                                return call('run_specialist', { name: 'math', task: 'Read ' + catalogTicket })
                            assert.ok(names.includes('mcp__math__catalog'))
                            assert.ok(!names.includes('catalog'))
                            if (last._getType() !== 'tool') return call('skill_view', { name: 'unassigned' })
                            if (last.content.includes('no such saved playbook')) return call('skill_view', { name: 'manual' })
                            assert.ok(last.content.includes('Read the assigned ticket catalog.'))
                            return call('mcp__math__catalog', { input: catalogTicket })
                        }
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
                        await holdTicket(ticket)
                        if (input.includes('Decline')) throw new Error('Fixture provider declined this ticket.')
                        return answer('Receipt ' + ticket)
                    }
                }
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
            async invoke(messages) {
                const text = messages.map((message) => String(message.content)).join(' ')
                const ticket = text.match(/TKT-50[34]/)?.[0]
                if (ticket && String(messages[0].content).includes('You route work for'))
                    return answer(JSON.stringify({ steps: [{ specialist: 'math', task: 'Read ' + ticket }] }))
                if (ticket && text.includes('Catalog receipt ' + ticket)) return answer('Catalog receipt ' + ticket)
                return answer('Ticket')
            }
        }
    }
}
