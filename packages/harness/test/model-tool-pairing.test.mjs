import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invokeChat } from '../model.mjs'
import { runNativeToolLoop } from '../runtime/native-prime.mjs'

const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
const inputs = [
    { id: 'shared' },
    { id: 'shared_d2' },
    { id: 'shared' },
    { id: 'shared|fc_four' },
    { id: 'fc_five', call_id: 'wire-five' },
    {},
    { id: 'other' }
]
const ids = ['shared', 'shared_d2', 'shared_d3', 'shared_d4', 'wire-five', 'call_087c6fb8bf6f', 'other']
const calls = inputs.map((fields, index) => ({
    ...fields,
    function: { name: 'lookup', arguments: JSON.stringify({ row: index + 1 }) }
}))

test('a strict model can match every native result when a provider reuses or omits a tool-call ID', async () => {
    let followups = 0
    const chat = {
        bindTools() {
            return this
        },
        async invoke(messages) {
            if (!messages.some((m) => m.getType() === 'tool')) {
                return {
                    content: '',
                    additional_kwargs: {
                        tool_calls: structuredClone(calls),
                        __openai_function_call_ids__: { shared: 'fc_ambiguous', other: 'fc_seven' }
                    }
                }
            }
            followups++
            const turn = messages.find((m) => m.getType() === 'ai')
            assert.deepEqual(
                turn.tool_calls.map((c) => c.id),
                ids
            )
            assert.deepEqual(
                turn.tool_calls.map((c) => c.args.row),
                [1, 2, 3, 4, 5, 6, 7]
            )
            assert.deepEqual(
                { ...turn.additional_kwargs.__openai_function_call_ids__ },
                {
                    shared_d4: 'fc_four',
                    'wire-five': 'fc_five',
                    other: 'fc_seven'
                }
            )
            assert.deepEqual(
                messages.filter((m) => m.getType() === 'tool').map((m) => [m.tool_call_id, m.content]),
                ids.map((id, i) => [id, 'row ' + (i + 1)])
            )
            return { content: 'seven distinct results' }
        }
    }
    const transcript = [{ role: 'user', content: 'Read each of the seven rows' }]
    for (let turn = 0; turn < 2; turn++) {
        const dispatched = []
        const answer = await runNativeToolLoop({
            messages: transcript,
            tools,
            maxCalls: 7,
            complete: (messages) => invokeChat({ chat, toolCalling: true }, { messages, tools, toolChoice: 'auto' }),
            execute(name, args) {
                assert.equal(name, 'lookup')
                dispatched.push(args.row)
                return 'row ' + args.row
            }
        })
        assert.equal(answer, 'seven distinct results')
        assert.deepEqual(dispatched, [1, 2, 3, 4, 5, 6, 7])
    }
    assert.equal(followups, 2)
})

test('the streaming model path retains a uniquely mapped Responses item even if its pairing ID collides with a generated suffix', async () => {
    const chat = {
        invoke: assert.fail,
        async *stream() {
            yield {
                content: 'batch',
                tool_calls: ['r', 'r', 'r_d2'].map((id) => ({ id, name: 'lookup', args: { row: 1 } })),
                additional_kwargs: { __openai_function_call_ids__: { r: 'fc_ambiguous', r_d2: 'fc_third' } }
            }
        }
    }
    const deltas = []
    const reply = await invokeChat({ chat }, { messages: [], onDelta: (part) => deltas.push(part) })
    assert.deepEqual(deltas, ['batch'])
    assert.deepEqual(
        reply.toolCalls.map((c) => [c.id, c.response_item_id]),
        [
            ['r', undefined],
            ['r_d2', undefined],
            ['r_d2_d2', 'fc_third']
        ]
    )
})

test('Responses replays repeated calls from different model rounds with their own items and results', async () => {
    const oversized = 'call_' + 'a'.repeat(64)
    const shortened = 'call_4d456232dc607c071b94702546032bd2'
    const ids = ['same', 'same', 'same_dup1', oversized, oversized]
    const expected = ['same', 'same_dup1', 'same_dup1_dup1', shortened, shortened + '_dup1']
    const history = [{ role: 'user', content: 'Read the five rows.' }]
    for (const [index, id] of ids.entries()) {
        history.push({
            role: 'assistant',
            tool_calls: [{ id, response_item_id: 'fc_row' + index, function: { name: 'lookup', arguments: '{}' } }]
        })
        history.push({ role: 'tool', tool_call_id: id, content: String(index) })
    }
    const saved = structuredClone(history)
    const chat = {
        useResponsesApi: true,
        async invoke(messages) {
            const assistants = messages.filter((message) => message.getType() === 'ai')
            const results = messages.filter((message) => message.getType() === 'tool')
            assert.deepEqual(
                assistants.map((message) => message.tool_calls[0].id),
                expected
            )
            assert.deepEqual(
                assistants.map((message, i) => message.additional_kwargs.__openai_function_call_ids__[expected[i]]),
                ids.map((_, i) => 'fc_row' + i)
            )
            assert.deepEqual(
                results.map((message) => [message.tool_call_id, message.content]),
                expected.map((id, i) => [id, String(i)])
            )
            return { content: 'verified' }
        }
    }
    assert.equal((await invokeChat({ chat }, { messages: history })).content, 'verified')
    assert.deepEqual(history, saved)
})

test('ordinary Chat Completions replays the original call IDs across distinct rounds', async () => {
    const id = 'call_' + 'b'.repeat(64)
    const history = [{ role: 'user', content: 'Read the rows.' }]
    for (const content of ['first', 'second']) {
        history.push({
            role: 'assistant',
            tool_calls: [{ id, response_item_id: 'fc_' + content, function: { name: 'lookup', arguments: '{}' } }]
        })
        history.push({ role: 'tool', tool_call_id: id, content })
    }
    const chat = {
        async invoke(messages) {
            assert.deepEqual(
                messages.filter((message) => message.getType() === 'ai').map((message) => message.tool_calls[0].id),
                [id, id]
            )
            assert.deepEqual(
                messages.filter((message) => message.getType() === 'tool').map((message) => message.tool_call_id),
                [id, id]
            )
            return { content: 'ok' }
        }
    }
    assert.equal((await invokeChat({ chat }, { messages: history })).content, 'ok')
})

test('a Responses model can replay legacy function calls that have no stored response item IDs', async () => {
    const id = 'call_legacy'
    const messages = [{ role: 'user', content: 'Read two rows.' }]
    for (const value of [1, 2]) {
        messages.push({ role: 'assistant', tool_calls: [{ id, function: { name: 'lookup', arguments: '{}' } }] })
        messages.push({ role: 'tool', tool_call_id: id, content: String(value) })
    }
    const chat = {
        _useResponsesApi: () => true,
        async invoke(converted) {
            const input = converted.filter((message) => message.getType() === 'ai')
            const output = converted.filter((message) => message.getType() === 'tool')
            assert.deepEqual(
                input.map((message) => message.tool_calls[0].id),
                [id, id + '_dup1']
            )
            assert.deepEqual(
                output.map((message) => message.tool_call_id),
                [id, id + '_dup1']
            )
            return { content: 'ok' }
        }
    }
    assert.equal((await invokeChat({ chat }, { messages })).content, 'ok')
})
