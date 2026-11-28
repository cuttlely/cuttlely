const assert = require('node:assert/strict')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const Module = require('node:module')
const approved = 'http://catalog.example.invalid/shipping'
const read = (messages) => messages.map((m) => String(m.content || ''))
const say = (content) => ({ content, usage_metadata: { input_tokens: 10, output_tokens: 4 } })
const call = (name, args) => ({ ...say(''), tool_calls: [{ id: randomUUID(), name, args }] })
function answer(tools, messages) {
    const texts = read(messages),
        history = texts.join('\n'),
        last = texts.at(-1)
    const names = tools.map((t) => t.name || t.function?.name)
    const marker = last?.match(/Shipping reference [a-f0-9]{8}\./)?.[0]
    if (names.includes('run_specialist')) {
        if (marker) return say(marker)
        return call('run_specialist', {
            name: 'browser',
            task: history.includes('other action') ? 'Read the other action fixture.' : 'Report the shipping desk text.'
        })
    }
    if (texts[0]?.includes('You route work for'))
        return say(JSON.stringify({ steps: [{ specialist: 'browser', task: 'Report the shipping desk text.' }] }))
    if (names.includes('browser_navigate')) {
        fs.appendFileSync(process.env.QA_STATIC_MODEL_PIDS, process.pid + '\n')
        if (marker) return say(marker)
        if (history.includes('other action')) return call('browser_navigate', { url: 'http://catalog.example.invalid/unreviewed' })
        if (last?.includes('"title"')) return call('browser_snapshot', { full: true })
        return call('browser_navigate', { url: approved })
    }
    return say(marker || 'Shipping desk report.')
}
const load = Module._load
Module._load = function (id, parent) {
    const lib = load.apply(this, arguments)
    if (id !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, options) {
                assert.equal(options.apiKey, process.env.QA_STATIC_MODEL)
                super(id, options)
            }
            bindTools(tools) {
                return {
                    invoke: async (messages) => answer(tools, messages),
                    stream: async function* (messages) {
                        yield answer(tools, messages)
                    }
                }
            }
            async invoke(messages) {
                return answer([], messages)
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
