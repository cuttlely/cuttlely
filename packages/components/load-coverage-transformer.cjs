'use strict'

// ts-jest, plus a compile-time log the node load test reads.
// The transformer and the test do not share globalThis (Jest runs the
// transformer in its own vm), so compile time is appended to a file.
// getCacheKey is ts-jest's own key: a warm cache skips this entirely.
const fs = require('fs')
const os = require('os')
const path = require('path')
const tsJest = require('ts-jest').default

const inner = tsJest.createTransformer()

function transformLogPath() {
    const id = process.env.JEST_WORKER_ID || '0'
    return path.join(os.tmpdir(), `cuttlely-node-load-${id}.log`)
}

let removeLogOnExit = false

function charge(ms) {
    const logPath = transformLogPath()
    if (!removeLogOnExit) {
        removeLogOnExit = true
        process.on('exit', () => {
            try {
                fs.rmSync(logPath, { force: true })
            } catch {
                // The load test removes the file itself.
            }
        })
    }
    fs.appendFileSync(logPath, `${ms}\n`)
}

function wrap(fn) {
    return function timedTransform(...args) {
        const start = Date.now()
        const result = fn.apply(inner, args)
        if (result && typeof result.then === 'function') {
            return result.then((value) => {
                charge(Date.now() - start)
                return value
            })
        }
        charge(Date.now() - start)
        return result
    }
}

const wrapped = {
    getCacheKey: (...args) => inner.getCacheKey(...args),
    process: wrap(inner.process)
}

if (inner.getCacheKeyAsync) wrapped.getCacheKeyAsync = (...args) => inner.getCacheKeyAsync(...args)
if (inner.processAsync) wrapped.processAsync = wrap(inner.processAsync)

module.exports = wrapped
module.exports.transformLogPath = transformLogPath
