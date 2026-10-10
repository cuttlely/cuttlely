// Fails the process if a module resolve reaches a Flowise SSO provider.
// The provider file is not executed.
const Module = require('module')
const path = require('path')
const marker = `${path.sep}enterprise${path.sep}sso${path.sep}`
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
    const resolved = resolve.call(this, request, parent, isMain, options)
    if (typeof resolved === 'string' && resolved.includes(marker)) {
        const error = new Error('SSO provider module was loaded')
        error.code = 'CUTTLELY_SSO_LOADED'
        throw error
    }
    return resolved
}
