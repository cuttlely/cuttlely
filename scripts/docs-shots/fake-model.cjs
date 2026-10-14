'use strict'

// In-process chat model for the docs screenshot server. No provider is called and no key is read.
// Answers are the bakery lines the guides already use. The system text decides which wording,
// so Live and a draft can differ without a model account.

const { AIMessage } = require('@langchain/core/messages')

function askedText(messages) {
    const parts = []
    const walk = (value, depth) => {
        if (value == null || depth > 6) return
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

function answerFor(text) {
    const asked = text.toLowerCase()
    // The system text is in the same string. Match the question itself, then use the system text for the wording.
    if (asked.includes('why was the sourdough late')) return 'The oven was busy.'
    if (asked.includes('can i pick up on monday')) return 'Yes, pickup on Monday is after 9.'
    if (asked.includes('what time do you open on saturday')) {
        return asked.includes('7 am') ? 'We open at 7 AM on Saturdays.' : 'We open at 8 AM on Saturdays.'
    }
    if (asked.includes('do you have gluten-free bread today')) {
        return asked.includes('baked every day')
            ? 'Yes, we bake gluten-free bread every day.'
            : 'No, we bake gluten-free bread only on Tuesdays.'
    }
    if (asked.includes('do you have rye loaves today')) return 'Yes, rye is baked every morning.'
    if (asked.includes('birthday cake for friday')) {
        return asked.includes('please place')
            ? 'Yes, please place your order by Wednesday for a Friday birthday cake.'
            : 'Yes, you need to place your birthday cake order by Wednesday.'
    }
    return 'We can help with that at the counter.'
}

function generation(text) {
    const message = new AIMessage({ content: text })
    const promptTokens = 48
    const completionTokens = Math.max(8, Math.round(text.length / 4))
    return {
        text,
        message,
        llmOutput: {
            tokenUsage: {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens
            }
        }
    }
}

function patchChat(exported) {
    if (!exported || exported.__cuttlelyDocsShot) return
    const ChatOpenAI = exported.ChatOpenAI || (exported.default && exported.default.ChatOpenAI)
    if (!ChatOpenAI || ChatOpenAI.prototype.__cuttlelyDocsShot) return
    ChatOpenAI.prototype.__cuttlelyDocsShot = true
    exported.__cuttlelyDocsShot = true
    const reply = async function reply(messages) {
        const text = answerFor(askedText(messages))
        return generation(text)
    }
    ChatOpenAI.prototype._generate = async function fakeGenerate(messages) {
        const made = await reply(messages)
        return { generations: [{ text: made.text, message: made.message }], llmOutput: made.llmOutput }
    }
    ChatOpenAI.prototype._streamResponseChunks = async function* fakeStream(messages) {
        const made = await reply(messages)
        yield { text: made.text, message: made.message }
    }
}

const Module = require('module')
const originalLoad = Module._load
Module._load = function cuttlelyDocsShotLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments)
    if (typeof request === 'string' && request.includes('@langchain/openai')) patchChat(exported)
    return exported
}

function isLocal(target) {
    const value = typeof target === 'string' ? target : target && target.href ? target.href : String(target || '')
    return (
        value.startsWith('http://127.0.0.1') || value.startsWith('http://localhost') || value.startsWith('file:') || value.startsWith('/')
    )
}

const originalFetch = globalThis.fetch
if (typeof originalFetch === 'function') {
    globalThis.fetch = function cuttlelyDocsShotFetch(target, init) {
        if (isLocal(target)) return originalFetch(target, init)
        return Promise.reject(new Error('docs shot blocked a non-local fetch'))
    }
}
