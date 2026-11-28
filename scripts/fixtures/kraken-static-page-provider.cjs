const assert = require('node:assert/strict')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const Module = require('node:module')
const approved = 'http://catalog.example.invalid/shipping'
const linked = 'http://catalog.example.invalid/index'
const read = (messages) => messages.map((m) => String(m.content || ''))
const linkTask = (history) => {
    const option = ['bad ref', 'other ref', 'bare ref', 'refresh ref'].find((word) => history.includes(word))
    return 'Read the linked shipping detail.' + (option ? ' ' + option : '')
}
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
            task: history.includes(linked)
                ? linkTask(history)
                : history.includes('other action')
                ? 'Read the other action fixture.'
                : 'Report the shipping desk text.'
        })
    }
    if (texts[0]?.includes('You route work for'))
        return say(
            JSON.stringify({
                steps: [{ specialist: 'browser', task: history.includes(linked) ? linkTask(history) : 'Report the shipping desk text.' }]
            })
        )
    if (names.includes('browser_navigate')) {
        fs.appendFileSync(process.env.QA_STATIC_MODEL_PIDS, process.pid + '\n')
        if (marker) {
            if (names.includes('browser_click')) {
                const value = JSON.parse(last.match(/\n(\{[^\n]+\})\n<\/untrusted_tool_result>/)[1])
                assert.equal(value.element_count, 1)
                assert.equal(
                    value.snapshot,
                    '- main\n  - heading "Details" [level=1, ref=e1]\n  - paragraph\n    - StaticText ' + JSON.stringify(marker)
                )
            }
            return say(marker)
        }
        if (names.includes('browser_click')) {
            const value = last?.match(/\n(\{[^\n]+\})\n<\/untrusted_tool_result>/)?.[1]
            const item = value ? JSON.parse(value) : {}
            if (item.clicked) {
                assert.equal(item.clicked, '@e2')
                if (history.includes('refresh ref')) return call('browser_snapshot', { full: false })
                return call('browser_snapshot', { full: true })
            }
            if (item.snapshot && !item.url && /heading "Details"/.test(item.snapshot)) {
                assert.equal(item.snapshot, '- main\n  - heading "Details" [level=1, ref=e1]')
                return call('browser_snapshot', { full: true })
            }
            if (item.url || item.snapshot) {
                if (item.url) assert.equal(item.url, linked)
                if (item.url && history.includes('refresh ref')) return call('browser_snapshot', {})
                assert.equal(item.success, true)
                const ref = /link "Shipping details" \[ref=(e[1-9]\d*)\]/.exec(item.snapshot)?.[1]
                if (ref) {
                    assert.equal(ref, 'e2')
                    assert.equal(item.element_count, 3)
                    assert.equal(
                        item.snapshot,
                        '- main\n  - heading "Catalog" [level=1, ref=e1]\n  - link "Shipping details" [ref=e2]\n  - link "Other text" [ref=e3]'
                    )
                }
                if (!ref) return call('browser_click', { ref: '@e999999' })
                return call('browser_click', {
                    ref: history.includes('bad ref')
                        ? '@e999999'
                        : history.includes('other ref')
                        ? '@e3'
                        : history.includes('bare ref')
                        ? ref
                        : '@' + ref
                })
            }
            return call('browser_navigate', { url: linked })
        }
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
