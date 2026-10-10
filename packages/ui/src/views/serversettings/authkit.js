// Set up AuthKit: page logic for the wizard. Secrets typed here go to the server for the test and are never read back.

export const CALLBACK_PATH = '/api/v1/auth/callback'

/** Staging or Production, from the API key prefix. */
export function detectEnvironment(apiKey) {
    const value = String(apiKey ?? '').trim()
    if (!value) return null
    if (value.startsWith('sk_test_')) return 'staging'
    if (value.startsWith('sk_live_')) return 'production'
    return 'unknown'
}

export const ENVIRONMENT_LABELS = { staging: 'Staging', production: 'Production', unknown: 'Not a WorkOS API key' }

export function defaultRedirect(origin) {
    return `${String(origin ?? '').replace(/\/+$/, '')}${CALLBACK_PATH}`
}

/** The four addresses to enter in WorkOS, Applications, Redirects. Null while the redirect is not a valid address. */
export function authKitAddresses(redirectUri) {
    let url
    try {
        url = new URL(String(redirectUri ?? '').trim())
    } catch {
        return null
    }
    if (!/^https?:$/.test(url.protocol)) return null
    const origin = url.origin
    return [
        { label: 'Redirect URI', value: url.toString() },
        { label: 'Sign-out URI', value: `${origin}/signin` },
        { label: 'App homepage URL', value: origin },
        { label: 'Initiate login URI', value: `${origin}/api/v1/auth/login` }
    ]
}

/** A new session seal: 32 random bytes, base64 (44 characters). Made in the browser, sent only to this server. */
export function generateSeal(random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
    const bytes = random(new Uint8Array(32))
    let text = ''
    bytes.forEach((byte) => {
        text += String.fromCharCode(byte)
    })
    return globalThis.btoa(text)
}

/** Quick checks while typing. The server checks again before a test. */
export function fieldProblems(form, env) {
    const problems = {}
    if (form.apiKey && detectEnvironment(form.apiKey) === 'unknown')
        problems.apiKey = 'WorkOS API keys start with sk_test_ (Staging) or sk_live_ (Production).'
    if (form.clientId && !/^client_\S+$/.test(form.clientId.trim())) problems.clientId = 'The Client ID starts with client_.'
    const addresses = authKitAddresses(form.redirectUri)
    if (form.redirectUri && !addresses) problems.redirectUri = 'Use a full address, starting with https:// or http://.'
    else if (addresses && !String(form.redirectUri).trim().replace(/\/$/, '').endsWith(CALLBACK_PATH))
        problems.redirectUri = `It must end with ${CALLBACK_PATH}.`
    else if (addresses && env === 'production' && !String(form.redirectUri).startsWith('https://'))
        problems.redirectUri = 'Production needs an https:// address.'
    if (form.seal && form.seal.length < 32) problems.seal = 'Use Generate seal, or paste at least 32 characters.'
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) problems.email = 'That does not look like an email address.'
    return problems
}

/** What the wizard sends: typed secrets (blank keeps the saved one) and the plain values. */
export function wizardValues(form) {
    const values = {
        WORKOS_CLIENT_ID: form.clientId.trim(),
        WORKOS_REDIRECT_URI: form.redirectUri.trim(),
        CUTTLELY_BOOTSTRAP_EMAIL: form.email.trim()
    }
    if (form.apiKey.trim()) values.WORKOS_API_KEY = form.apiKey.trim()
    if (form.seal) values.WORKOS_COOKIE_PASSWORD = form.seal
    return values
}

/** Starting values: saved plain values, the owner's email, and this page's address. */
export function initialForm(settings, origin, ownerEmail) {
    const byKey = Object.fromEntries((settings ?? []).map((setting) => [setting.key, setting]))
    const plain = (key) => byKey[key]?.value ?? ''
    return {
        apiKey: '',
        clientId: plain('WORKOS_CLIENT_ID'),
        redirectUri: plain('WORKOS_REDIRECT_URI') || defaultRedirect(origin),
        seal: '',
        email: plain('CUTTLELY_BOOTSTRAP_EMAIL') || ownerEmail || '',
        savedKey: Boolean(byKey.WORKOS_API_KEY?.secret?.set),
        savedSeal: Boolean(byKey.WORKOS_COOKIE_PASSWORD?.secret?.set),
        locked: Object.fromEntries(
            ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_REDIRECT_URI', 'WORKOS_COOKIE_PASSWORD', 'CUTTLELY_BOOTSTRAP_EMAIL'].map(
                (key) => [key, Boolean(byKey[key]?.locked)]
            )
        )
    }
}

/** Which steps are ready to move on from. */
export function stepReady(step, form, options = {}) {
    const problems = fieldProblems(form, detectEnvironment(form.apiKey))
    // From the setup link there is no account yet, so the owner email is needed.
    if (step === 2 && options.needEmail && !form.email.trim()) return false
    if (step === 0) return (form.apiKey.trim() || form.savedKey) && form.clientId.trim() && !problems.apiKey && !problems.clientId
    if (step === 1) return Boolean(form.redirectUri.trim()) && !problems.redirectUri
    if (step === 2) return (form.seal || form.savedSeal) && !problems.seal && !problems.email
    return true
}
