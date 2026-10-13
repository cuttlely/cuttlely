// jsdom optionally loads the canvas package. The native addon is not built in this
// install, and that require throws before jsdom's own catch can settle. Stub it first.
const Module = require('module')
const { TextDecoder, TextEncoder } = require('util')
const originalRequire = Module.prototype.require
Module.prototype.require = function (id) {
    if (id === 'canvas') {
        return {
            createCanvas: () => ({ getContext: () => ({}) }),
            Image: class Image {}
        }
    }
    return originalRequire.apply(this, arguments)
}

const { TestEnvironment } = require('jest-environment-jsdom')

class JsdomCanvasEnvironment extends TestEnvironment {
    constructor(config, context) {
        super(config, context)
        this.global.TextEncoder = TextEncoder
        this.global.TextDecoder = TextDecoder
        this.global.IS_REACT_ACT_ENVIRONMENT = true
    }
}

module.exports = JsdomCanvasEnvironment
