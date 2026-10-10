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
        // A question with "smoke-slow" in it answers after a few seconds, for the shutdown drain check.
        if (JSON.stringify(messages || []).includes('smoke-slow')) await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
        return fakeGeneration()
    }
    ChatOpenAI.prototype._streamResponseChunks = async function* fakeStream() {
        yield { text: SMOKE_TEXT, message: aiMessage(SMOKE_TEXT) }
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
