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
