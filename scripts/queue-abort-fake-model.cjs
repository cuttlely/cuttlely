'use strict'

// Preload for the queue-mode abort test (scripts/queue-abort-e2e.mjs). The chat model streams fake tokens slowly in
// process and stops when the run's abort signal fires. Each start, stop and finish is appended as one JSON line to
// QUEUE_ABORT_MARKER, with the process id, so the test can tell which process ran the model and how far it got.
// No provider key is read and nothing leaves the machine.

const fs = require('fs')

const MARKER = process.env.QUEUE_ABORT_MARKER

function record(event, tokens, extra) {
    if (!MARKER) return
    fs.appendFileSync(MARKER, JSON.stringify({ pid: process.pid, event, tokens, at: Date.now(), ...extra }) + '\n')
}

function abortError() {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    return error
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(abortError())
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(abortError())
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })
}

function lastText(messages) {
    const last = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : undefined
    const content = last && last.content
    return typeof content === 'string' ? content : JSON.stringify(content || '')
}

// A question that contains "long" streams 400 tokens, 100 ms apart (40 s). Anything else streams 3 tokens.
async function* fakeTokens(messages, options) {
    const text = lastText(messages)
    const long = /long/i.test(text)
    const total = long ? 400 : 3
    const delay = long ? 100 : 5
    const signal = options && options.signal
    record('start', 0, { prompt: text.slice(0, 80) })
    let sent = 0
    try {
        for (; sent < total; sent++) {
            await wait(delay, signal)
            yield `t${sent} `
        }
    } catch (error) {
        record('aborted', sent)
        throw error
    }
    record('completed', sent)
}

function patchChat(exported) {
    const ChatOpenAI = exported && (exported.ChatOpenAI || (exported.default && exported.default.ChatOpenAI))
    if (!ChatOpenAI || ChatOpenAI.prototype.__cuttlelyQueueAbort) return
    const { AIMessage, AIMessageChunk } = require('@langchain/core/messages')
    const { ChatGenerationChunk } = require('@langchain/core/outputs')
    ChatOpenAI.prototype.__cuttlelyQueueAbort = true
    ChatOpenAI.prototype._generate = async function fakeGenerate(messages, options, runManager) {
        let text = ''
        for await (const token of fakeTokens(messages, options)) {
            text += token
            if (runManager) await runManager.handleLLMNewToken(token)
        }
        return {
            generations: [{ text, message: new AIMessage({ content: text }) }],
            llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        }
    }
    ChatOpenAI.prototype._streamResponseChunks = async function* fakeStream(messages, options, runManager) {
        for await (const token of fakeTokens(messages, options)) {
            const chunk = new ChatGenerationChunk({ text: token, message: new AIMessageChunk({ content: token }) })
            yield chunk
            if (runManager) await runManager.handleLLMNewToken(token, undefined, undefined, undefined, undefined, { chunk })
        }
    }
}

const Module = require('module')
const originalLoad = Module._load
Module._load = function cuttlelyQueueAbortLoad(request) {
    const exported = originalLoad.apply(this, arguments)
    if (typeof request === 'string' && request.includes('@langchain/openai')) patchChat(exported)
    return exported
}
