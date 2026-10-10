'use strict'

// Preload for the boot smoke. Chat model calls return a fixed reply in process.
// Anything else that tries to leave the machine throws. No provider key is read.

const SMOKE_TEXT = 'smoke-ok'
const SLOW_MS = 4000

function aiMessage(content) {
    const { AIMessage } = require('@langchain/core/messages')
    return new AIMessage({ content })
}

function fakeGeneration() {
    const message = aiMessage(SMOKE_TEXT)
    return {
        generations: [{ text: SMOKE_TEXT, message }],
        llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }
}

function patchChat(exported) {
    if (!exported || exported.__cuttlelySmoke) return
    const ChatOpenAI = exported.ChatOpenAI || (exported.default && exported.default.ChatOpenAI)
    if (!ChatOpenAI || ChatOpenAI.prototype.__cuttlelySmoke) return
    ChatOpenAI.prototype.__cuttlelySmoke = true
    ChatOpenAI.prototype._generate = async function fakeGenerate(messages) {
        await fakeProvider(this, messages)
        return fakeGeneration()
    }
    // A run with a token callback streams even when the card has streaming off, so the stream acts the same way.
    ChatOpenAI.prototype._streamResponseChunks = async function* fakeStream(messages) {
        await fakeProvider(this, messages)
        yield { text: SMOKE_TEXT, message: aiMessage(SMOKE_TEXT) }
    }
}

// The text of the messages a model call got: message contents (strings or content parts), whatever the message class.
function askedText(messages) {
    const parts = []
    const walk = (value, depth) => {
        if (value == null || depth > 5) return
        if (typeof value === 'string') return void parts.push(value)
        if (Array.isArray(value)) return void value.forEach((item) => walk(item, depth + 1))
        if (typeof value === 'object') {
            if ('content' in value) walk(value.content, depth + 1)
            if (typeof value.text === 'string') parts.push(value.text)
            if (value.kwargs) walk(value.kwargs.content, depth + 1)
        }
    }
    walk(messages, 0)
    return parts.join('\n')
}

// What the fake provider does before it answers, by the words in the question.
async function fakeProvider(model, messages) {
    const asked = askedText(messages)
    // "smoke-slow": answers after a few seconds, for the shutdown drain check.
    if (asked.includes('smoke-slow')) await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
    // "smoke-429": a provider that always answers 429 with Retry-After: 12, through the model's own retry logic
    // (model.caller), for the rate limit check.
    if (asked.includes('smoke-429')) {
        await model.caller.call(async () => {
            throw Object.assign(new Error('429 Rate limit reached for smoke-model on requests per min.'), {
                status: 429,
                headers: new Headers({ 'retry-after': '12' })
            })
        })
    }
}

const Module = require('module')
const originalLoad = Module._load
Module._load = function cuttlelySmokeLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments)
    if (typeof request === 'string' && request.includes('@langchain/openai')) patchChat(exported)
    return exported
}

function isLocal(target) {
    const value = typeof target === 'string' ? target : target && target.href ? target.href : String(target || '')
    return value.startsWith('http://127.0.0.1') || value.startsWith('http://localhost') || value.startsWith('/')
}

const originalFetch = globalThis.fetch
if (typeof originalFetch === 'function') {
    globalThis.fetch = function cuttlelySmokeFetch(target, init) {
        if (isLocal(target)) return originalFetch(target, init)
        return Promise.reject(new Error('smoke test blocked a non-local fetch'))
    }
}
