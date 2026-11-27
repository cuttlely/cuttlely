import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { DEFAULT_MODEL_CALL_TIMEOUT_MS, modelCallTimeoutMs } from './budget.mjs'
import { invokeChat } from './model.mjs'

const key = 'CUTTLELY_HARNESS_MODEL_CALL_TIMEOUT_MS'
const original = process.env[key]
afterEach(() => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
})

test('the model call cap keeps the default and reads the current environment on each call', () => {
    assert.equal(DEFAULT_MODEL_CALL_TIMEOUT_MS, 120000)
    delete process.env[key]
    assert.equal(modelCallTimeoutMs(), 120000)
    process.env[key] = '300000'
    assert.equal(modelCallTimeoutMs(), 300000)
    for (const value of ['', ' ', 'bad', '0', '-1', '999', '3600001', '1000.5', 'Infinity']) {
        assert.equal(modelCallTimeoutMs({ [key]: value }), 120000, value)
    }
    assert.equal(modelCallTimeoutMs({ [key]: '3600000' }), 3600000)
})

test('a raised cap lets a model call pass 120 seconds while a shorter caller deadline still wins', async (t) => {
    process.env[key] = '300000'
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.mock.method(AbortSignal, 'timeout', (ms) => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), ms)
        return controller.signal
    })
    let timeout
    const resolved = {
        chat: {
            async invoke(_messages, options) {
                timeout = options.timeout
                t.mock.timers.tick(120001)
                assert.equal(options.signal.aborted, false)
                return { content: 'completed after 120 seconds' }
            }
        }
    }
    assert.equal((await invokeChat(resolved, { messages: [] })).content, 'completed after 120 seconds')
    assert.equal(timeout, 300000)
    resolved.chat.invoke = async (_messages, options) => {
        timeout = options.timeout
        return { content: 'short deadline' }
    }
    await invokeChat(resolved, { messages: [], timeoutMs: 5000 })
    assert.equal(timeout, 5000)
    delete process.env[key]
    await invokeChat(resolved, { messages: [], timeoutMs: 300000 })
    assert.equal(timeout, 120000)
})

test('JSON tool-choice retries count both model calls and stream only the interpreted answer', async () => {
    const replies = ['{"tool":"unassigned","arguments":{"value":"private"}}', '{"answer":"done"}']
    const deltas = []
    const result = await invokeChat(
        {
            chat: {
                invoke: async () => ({
                    content: replies.shift(),
                    usage_metadata: { input_tokens: 9, output_tokens: 2, input_token_details: { cache_read: 3 } }
                })
            }
        },
        {
            messages: [{ role: 'user', content: 'Check.' }],
            tools: [{ function: { name: 'check', parameters: {} } }],
            onDelta: (s) => deltas.push(s)
        }
    )
    assert.deepEqual(deltas, ['done'])
    assert.equal(result.content, 'done')
    assert.deepEqual(result.usage, {
        prompt_tokens: 18,
        completion_tokens: 4,
        total_tokens: 22,
        prompt_tokens_details: { cached_tokens: 6 }
    })
})
