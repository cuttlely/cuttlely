// First-run setup: after the first account is created, the owner goes on to where they were headed. The optional
// "Keep a copy in GitHub" page (/setup/github) is no longer part of setup; the same card is in Version History.
export const GITHUB_STEP_PATH = '/setup/github'

const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/

function setupPathOk(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
    if (value[0] !== '/') return false
    if (value[1] === '/' || value[1] === '\\') return false
    if (value.includes('\\')) return false
    if (value.includes('//')) return false
    if (value.includes('://')) return false
    if (CONTROL.test(value)) return false
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false
    return true
}

function setupPathItself(value) {
    const pathOnly = value.split('?')[0].split('#')[0]
    return pathOnly === '/setup' || pathOnly === '/setup/' || pathOnly.startsWith('/setup/')
}

/**
 * A same-origin path only. One leading slash, no scheme, no backslash, no control character.
 * Each decoded form has to pass the same checks. Anything else, including /setup itself, is home.
 */
export function safeSetupNext(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/'
    let current = value
    for (let hop = 0; hop < 4; hop++) {
        if (!setupPathOk(current)) return '/'
        let decoded
        try {
            decoded = decodeURIComponent(current)
        } catch {
            return '/'
        }
        if (decoded === current) return setupPathItself(current) ? '/' : current
        current = decoded
    }
    if (!setupPathOk(current) || setupPathItself(current)) return '/'
    return current
}

// Where to go after setup: the page the owner was headed to, when it is a page of this app,
// otherwise the home page.
export function nextAfterSetup(state) {
    return safeSetupNext(state?.next)
}

// The GitHub step only matters while version history is on. With history off there is nothing to copy.
export function skipGithubStep(status) {
    return status?.state === 'off'
}

// Reads #code= first, then a legacy ?code=, and returns the address with that code removed.
export function readSetupCode(href) {
    const url = new URL(href, 'http://localhost')
    const hashBody = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    const hashParams = new URLSearchParams(hashBody)
    let code = ''
    if (hashParams.has('code')) code = hashParams.get('code') || ''
    hashParams.delete('code')
    const hashLeft = hashParams.toString()
    if (!code) code = url.searchParams.get('code') || ''
    url.searchParams.delete('code')
    const address = `${url.pathname}${url.search}${hashLeft ? `#${hashLeft}` : ''}`
    return { code, address }
}

let heldSetupCode = ''

/** Test hook. */
export function resetHeldSetupCode() {
    heldSetupCode = ''
}

// Clears #code= and ?code= before the caller does anything else. A second call keeps the code from the first.
export function readAndClearSetupCode(win) {
    const target = win || (typeof window === 'undefined' ? undefined : window)
    if (!target || !target.location) return heldSetupCode
    const { code, address } = readSetupCode(target.location.href)
    const here = `${target.location.pathname}${target.location.search}${target.location.hash}`
    if (here !== address && target.history && typeof target.history.replaceState === 'function') {
        target.history.replaceState(null, '', address)
    }
    if (code) heldSetupCode = code
    return code || heldSetupCode
}
