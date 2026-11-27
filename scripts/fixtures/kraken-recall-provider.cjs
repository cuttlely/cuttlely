// Only the saved provider's network boundary is simulated. Reading history always goes
// through the model tool response, including when prior chat context contains an answer.
const assert = require('node:assert/strict')
const Module = require('node:module')
const original = Module._load
const legacyAnswer = (messages) =>
    JSON.stringify(messages).includes('File the cobalt report.') ? 'Synthetic report detail. '.repeat(400).trimEnd() : expected
const expected = 'The synthetic parcel arrived at gate 17.'
const answer = (content) => ({
    content,
    response_metadata: { usage: { promptTokens: 8, completionTokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }
})
Module._load = function (request, parent) {
    const lib = original.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_RECALL_MODEL_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                const names = tools.map((t) => t.function?.name || t.name)
                return {
                    invoke: async (messages) => {
                        if (process.env.KRAKEN_RECALL_ENGINE === 'bundled') return answer(legacyAnswer(messages))
                        if (!names.includes('run_specialist') && names.includes('ops_status'))
                            return answer('A sealed blue file was delivered.')
                        assert.ok(names.includes('run_specialist'))
                        assert.ok(names.includes('session_search'))
                        const last = messages.at(-1)
                        if (last._getType() === 'tool') {
                            const response = JSON.parse(last.content)
                            assert.equal(response.mode, 'discover', response.error)
                            if (!response.count) return answer('No owned receipt.')
                            if (response.query === 'cobalt') {
                                assert.equal(response.count, 1)
                                assert.equal(response.results[0].matched_role, 'user')
                                assert.equal(response.results[0].messages[0].content, 'File the cobalt report.')
                                const preview = response.results[0].messages.find((m) => m.role === 'assistant')
                                assert.ok(preview.content_truncated && preview.content.length <= 4001)
                                return answer('Found the original request and its bounded report preview.')
                            }
                            if (response.query === 'azurite') {
                                assert.equal(response.count, 1)
                                assert.ok(
                                    response.results[0].messages.some(
                                        (m) => m.role === 'assistant' && m.content === 'A sealed blue file was delivered.'
                                    )
                                )
                                return answer('Recovered the application exchange.')
                            }
                            if (response.query === 'signed') {
                                assert.ok(
                                    response.results[0].messages.some(
                                        (m) =>
                                            m.role === 'assistant' && m.content === 'Recovered the signed exchange through session_search.'
                                    )
                                )
                                return answer('Confirmed the saved native reply.')
                            }
                            assert.equal(response.count, 1)
                            assert.ok(response.results[0].messages.some((m) => m.role === 'assistant' && m.content === expected))
                            return answer('Recovered the signed exchange through session_search.')
                        }
                        if (String(last.content).includes('separate account')) {
                            const incoming = JSON.stringify(messages)
                            assert.ok(
                                !incoming.includes('gate 17') &&
                                    !incoming.includes('saffron') &&
                                    !incoming.includes('Recovered the signed exchange'),
                                'another person’s prior messages entered the automatic prompt'
                            )
                        }
                        if (String(last.content).includes('Store the azurite')) return answer('A sealed blue file was delivered.')
                        if (String(last.content).includes('earlier cobalt request'))
                            return {
                                ...answer(''),
                                tool_calls: [
                                    { name: 'session_search', id: 'recall-long-report', args: { query: 'cobalt', role_filter: 'user' } }
                                ]
                            }
                        const blue = String(last.content).includes('Find the prior blue case.')
                        const previousNative = String(last.content).includes('native reply')
                        return {
                            ...answer(''),
                            tool_calls: [
                                {
                                    name: 'session_search',
                                    id: 'recall-saved-turn',
                                    args: blue
                                        ? { query: 'azurite', role_filter: 'user' }
                                        : previousNative
                                        ? { query: 'signed', role_filter: 'assistant' }
                                        : { query: 'saffron', role_filter: 'user' }
                                }
                            ]
                        }
                    }
                }
            }
            async invoke(messages) {
                if (String(messages[0]?.content).startsWith('You name chat sessions.')) return answer('Parcel receipt')
                if (process.env.KRAKEN_RECALL_ENGINE === 'native') return answer('A sealed blue file was delivered.')
                assert.equal(process.env.KRAKEN_RECALL_ENGINE, 'bundled')
                return answer(legacyAnswer(messages))
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
