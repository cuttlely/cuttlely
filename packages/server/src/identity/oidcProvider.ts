/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import {
    constants,
    createCipheriv,
    createDecipheriv,
    createHash,
    createPublicKey,
    hkdfSync,
    randomBytes,
    timingSafeEqual,
    verify as verifySignature
} from 'crypto'
import type { DataSource } from 'typeorm'
import { secureFetch } from '@cuttlely/components'
import { OidcConfiguration, consumeOidcTransaction, createOidcTransaction, oidcProviderKey, readOidcConfiguration } from './oidcStore'

export const OIDC_TRANSACTION_SECRET = 'CUTTLELY_OIDC_TRANSACTION_SECRET'
export const OIDC_TRANSACTION_MS = 10 * 60 * 1000
const MAX_DOCUMENT_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 5_000
const JWKS_MAX_AGE_MS = 60 * 60 * 1000
const JWKS_DEFAULT_AGE_MS = 5 * 60 * 1000
const UNKNOWN_KID_REFRESH_MS = 10_000
const ALGORITHMS = new Set(['RS256', 'PS256', 'ES256'])

export type OidcPurpose = 'signin' | 'test' | 'reauth' | 'invite'

export interface OidcDiscovery {
    issuer: string
    authorization_endpoint: string
    token_endpoint: string
    jwks_uri: string
    response_types_supported: string[]
    id_token_signing_alg_values_supported: string[]
    token_endpoint_auth_methods_supported?: string[]
    authorization_response_iss_parameter_supported?: boolean
}

export interface OidcEnvelope {
    verifier: string
    nonce: string
    expectedIssuer: string
    providerKey: string
    configFingerprint: string
    authEpoch: number
    redirectTarget: string
    purpose: OidcPurpose
    initiatingSession: string | null
    initiatingUserId: string | null
    requestTime: number
    invitationToken?: string
    authorizationResponseIssuer: boolean
}

export interface ValidatedOidcIdentity {
    providerKey: string
    subject: string
    issuer: string
    email?: string
    emailVerified?: boolean
    emailVerificationPresent: boolean
    xmsEdov?: boolean
    name?: string
    authTime?: number
}

export class OidcError extends Error {
    constructor(readonly category: 'configuration' | 'denied' | 'transaction' | 'response' | 'upstream', message: string) {
        super(message)
        this.name = 'OidcError'
    }
}

function b64url(value: Buffer): string {
    return value.toString('base64url')
}

function randomValue(bytes = 32): string {
    return b64url(randomBytes(bytes))
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('base64url')
}

function exactHostList(values: string[]): string[] {
    return [
        ...new Set(
            values
                .map((value) =>
                    value
                        .trim()
                        .toLowerCase()
                        .replace(/^\[|\]$/g, '')
                        .replace(/\.+$/, '')
                )
                .filter(Boolean)
        )
    ]
}

function loopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === 'ip6-localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function checkedUrl(raw: string, config: Pick<OidcConfiguration, 'privateIssuerHosts'>, name: string): URL {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        throw new OidcError('configuration', `${name} is not a valid URL.`)
    }
    if (url.username || url.password || url.hash) throw new OidcError('configuration', `${name} contains unsupported URL parts.`)
    const allowed = exactHostList(config.privateIssuerHosts)
    if (url.protocol !== 'https:') {
        if (
            url.protocol !== 'http:' ||
            !loopbackHost(url.hostname) ||
            !allowed.includes(url.hostname.toLowerCase().replace(/^\[|\]$/g, ''))
        ) {
            throw new OidcError('configuration', `${name} must use https.`)
        }
    }
    return url
}

async function boundedJson(
    url: string,
    config: OidcConfiguration,
    init: Record<string, unknown> = {}
): Promise<{
    value: Record<string, unknown>
    headers: { get(name: string): string | null }
}> {
    checkedUrl(url, config, 'OIDC endpoint')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        const response = await secureFetch(url, { ...(init as any), signal: controller.signal as any }, 0, {
            allowedPrivateHostnames: exactHostList(config.privateIssuerHosts)
        } as any)
        if (response.status >= 300 && response.status < 400) throw new OidcError('upstream', 'The OIDC endpoint returned a redirect.')
        if (!response.ok) throw new OidcError('upstream', `The OIDC endpoint returned status ${response.status}.`)
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response.body as any) {
            const bytes = Buffer.from(chunk)
            size += bytes.length
            if (size > MAX_DOCUMENT_BYTES) throw new OidcError('upstream', 'The OIDC response is too large.')
            chunks.push(bytes)
        }
        let value: unknown
        try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
            throw new OidcError('response', 'The OIDC endpoint returned malformed JSON.')
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OidcError('response', 'The OIDC response is malformed.')
        return { value: value as Record<string, unknown>, headers: response.headers }
    } catch (error) {
        if (error instanceof OidcError) throw error
        throw new OidcError('upstream', 'The OIDC endpoint could not be reached.')
    } finally {
        clearTimeout(timer)
    }
}

export async function discoverOidc(config: OidcConfiguration): Promise<OidcDiscovery> {
    const issuerUrl = checkedUrl(config.issuer, config, 'Issuer URL')
    const issuer = issuerUrl.toString().replace(/\/$/, issuerUrl.pathname === '/' ? '' : '/')
    const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
    const { value } = await boundedJson(discoveryUrl, config)
    if (value.issuer !== config.issuer) throw new OidcError('response', 'Discovery issuer does not match the configured issuer.')
    const authorization = typeof value.authorization_endpoint === 'string' ? value.authorization_endpoint : ''
    const token = typeof value.token_endpoint === 'string' ? value.token_endpoint : ''
    const jwks = typeof value.jwks_uri === 'string' ? value.jwks_uri : ''
    if (!authorization || !token || !jwks) throw new OidcError('response', 'Discovery is missing a required endpoint.')
    checkedUrl(authorization, config, 'Authorization endpoint')
    checkedUrl(token, config, 'Token endpoint')
    checkedUrl(jwks, config, 'JWKS endpoint')
    const responseTypes = Array.isArray(value.response_types_supported) ? value.response_types_supported.map(String) : []
    if (!responseTypes.includes('code')) throw new OidcError('response', 'Discovery does not support the code response type.')
    const algorithms = Array.isArray(value.id_token_signing_alg_values_supported)
        ? value.id_token_signing_alg_values_supported.map(String)
        : []
    if (!algorithms.some((algorithm) => ALGORITHMS.has(algorithm))) {
        throw new OidcError('response', 'Discovery does not advertise a supported ID token algorithm.')
    }
    const methods = Array.isArray(value.token_endpoint_auth_methods_supported)
        ? value.token_endpoint_auth_methods_supported.map(String)
        : undefined
    if (methods && !methods.some((method) => method === 'client_secret_post' || method === 'client_secret_basic')) {
        throw new OidcError('response', 'Discovery does not advertise a supported client authentication method.')
    }
    return {
        issuer: config.issuer,
        authorization_endpoint: authorization,
        token_endpoint: token,
        jwks_uri: jwks,
        response_types_supported: responseTypes,
        id_token_signing_alg_values_supported: algorithms,
        token_endpoint_auth_methods_supported: methods,
        authorization_response_iss_parameter_supported: value.authorization_response_iss_parameter_supported === true
    }
}

function transactionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
    const source = env[OIDC_TRANSACTION_SECRET]
    if (!source || Buffer.byteLength(source) < 32) throw new OidcError('configuration', `${OIDC_TRANSACTION_SECRET} is not configured.`)
    return Buffer.from(
        hkdfSync(
            'sha256',
            Buffer.from(source),
            Buffer.from('cuttlely-oidc-transaction-salt-v1'),
            Buffer.from('cuttlely-oidc-transaction-envelope-v1'),
            32
        )
    )
}

export function encryptOidcEnvelope(envelope: OidcEnvelope, env: NodeJS.ProcessEnv = process.env): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', transactionKey(env), iv)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), 'utf8'), cipher.final()])
    return `v1.${b64url(iv)}.${b64url(ciphertext)}.${b64url(cipher.getAuthTag())}`
}

export function decryptOidcEnvelope(value: string, env: NodeJS.ProcessEnv = process.env): OidcEnvelope {
    const [version, ivText, ciphertextText, tagText, extra] = value.split('.')
    if (version !== 'v1' || !ivText || !ciphertextText || !tagText || extra !== undefined) {
        throw new OidcError('transaction', 'The sign-in transaction is invalid.')
    }
    try {
        const decipher = createDecipheriv('aes-256-gcm', transactionKey(env), Buffer.from(ivText, 'base64url'))
        decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
        const plain = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8')
        return JSON.parse(plain) as OidcEnvelope
    } catch {
        throw new OidcError('transaction', 'The sign-in transaction is invalid.')
    }
}

export function browserSessionBinding(cookies: Record<string, string | undefined>): string | null {
    const values = ['cuttlely-local-session', 'wos-session']
        .map((name) => (cookies[name] ? `${name}:${cookies[name]}` : ''))
        .filter(Boolean)
        .join('\n')
    return values ? createHash('sha256').update(values).digest('hex') : null
}

const REDIRECT_TARGETS = new Set(['/', '/authentication-settings'])

function localRedirect(value: string): string {
    return REDIRECT_TARGETS.has(value) ? value : '/'
}

export async function beginOidcAuthorization(input: {
    dataSource: DataSource
    slot: 'draft' | 'active'
    installationId: string
    authenticationEpoch: number
    callbackUrl: string
    redirectTarget: string
    purpose: OidcPurpose
    initiatingSession: string | null
    initiatingUserId?: string | null
    invitationToken?: string
    now?: number
}): Promise<{ url: string; state: string; config: OidcConfiguration }> {
    const config = await readOidcConfiguration(input.dataSource, input.slot)
    if (!config || config.health !== 'ready') throw new OidcError('configuration', 'OIDC is not configured.')
    const discovery = (config.discovery || (await discoverOidc(config))) as unknown as OidcDiscovery
    const verifier = randomValue(48)
    const nonce = randomValue()
    const state = randomValue()
    const now = input.now ?? Date.now()
    const envelope: OidcEnvelope = {
        verifier,
        nonce,
        expectedIssuer: config.issuer,
        providerKey: oidcProviderKey(input.installationId, config.issuer, config.clientId),
        configFingerprint: config.fingerprint,
        authEpoch: input.authenticationEpoch,
        redirectTarget: localRedirect(input.redirectTarget),
        purpose: input.purpose,
        initiatingSession: input.initiatingSession,
        initiatingUserId: input.initiatingUserId || null,
        requestTime: now,
        invitationToken: input.invitationToken,
        authorizationResponseIssuer: discovery.authorization_response_iss_parameter_supported === true
    }
    await createOidcTransaction(input.dataSource, sha256(state), encryptOidcEnvelope(envelope), now, now + OIDC_TRANSACTION_MS)
    const url = new URL(discovery.authorization_endpoint)
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', input.callbackUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', sha256(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    if (input.purpose === 'reauth') {
        url.searchParams.set('prompt', 'login')
        url.searchParams.set('max_age', '0')
    }
    return { url: url.toString(), state, config }
}

async function consumeEnvelope(dataSource: DataSource, state: string, now: number): Promise<OidcEnvelope> {
    const encrypted = await consumeOidcTransaction(dataSource, sha256(state), now)
    if (!encrypted) throw new OidcError('transaction', 'The sign-in transaction expired or was already used.')
    const envelope = decryptOidcEnvelope(encrypted)
    if (envelope.requestTime + OIDC_TRANSACTION_MS <= now) throw new OidcError('transaction', 'The sign-in transaction expired.')
    return envelope
}

async function exchangeCode(config: OidcConfiguration, discovery: OidcDiscovery, code: string, verifier: string, callbackUrl: string) {
    const secret = process.env[config.clientSecretEnvVar]
    if (!secret) throw new OidcError('configuration', 'The OIDC client secret is not set.')
    const methods = discovery.token_endpoint_auth_methods_supported || ['client_secret_basic']
    const method = methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic'
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: config.clientId,
        code_verifier: verifier
    })
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    if (method === 'client_secret_post') body.set('client_secret', secret)
    else headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${secret}`).toString('base64')}`
    return boundedJson(discovery.token_endpoint, config, { method: 'POST', headers, body: body.toString() })
}

interface JwksCacheEntry {
    keys: Record<string, unknown>[]
    expiresAt: number
    refreshedAt: number
}
const jwksCache = new Map<string, JwksCacheEntry>()
const unknownKidRefresh = new Map<string, number>()

function cacheAge(header: string | null): number {
    const match = header?.match(/(?:^|,)\s*max-age=(\d+)/i)
    if (!match) return JWKS_DEFAULT_AGE_MS
    return Math.min(JWKS_MAX_AGE_MS, Math.max(0, Number(match[1]) * 1000))
}

async function jwks(config: OidcConfiguration, discovery: OidcDiscovery, force = false): Promise<JwksCacheEntry> {
    const now = Date.now()
    const cached = jwksCache.get(discovery.jwks_uri)
    if (!force && cached && cached.expiresAt > now) return cached
    const response = await boundedJson(discovery.jwks_uri, config)
    const keys = Array.isArray(response.value.keys)
        ? response.value.keys.filter((key): key is Record<string, unknown> =>
              Boolean(key && typeof key === 'object' && !Array.isArray(key))
          )
        : []
    if (!keys.length) throw new OidcError('response', 'The JWKS response has no usable keys.')
    const entry = { keys, expiresAt: now + cacheAge(response.headers.get('cache-control')), refreshedAt: now }
    jwksCache.set(discovery.jwks_uri, entry)
    return entry
}

export async function checkOidcConfiguration(config: OidcConfiguration): Promise<OidcDiscovery> {
    const discovery = await discoverOidc(config)
    await jwks(config, discovery, true)
    return discovery
}

function jsonPart(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
        return parsed
    } catch {
        throw new OidcError('response', 'The ID token is malformed.')
    }
}

async function signingKey(config: OidcConfiguration, discovery: OidcDiscovery, kid: string): Promise<Record<string, unknown>> {
    let set = await jwks(config, discovery)
    let key = set.keys.find((candidate) => candidate.kid === kid)
    if (!key) {
        const now = Date.now()
        const refreshedAt = unknownKidRefresh.get(discovery.jwks_uri) || 0
        if (now - refreshedAt >= UNKNOWN_KID_REFRESH_MS) {
            unknownKidRefresh.set(discovery.jwks_uri, now)
            set = await jwks(config, discovery, true)
        }
        key = set.keys.find((candidate) => candidate.kid === kid)
    }
    if (!key) throw new OidcError('response', 'The ID token signing key is not available.')
    return key
}

export async function validateIdToken(
    token: string,
    config: OidcConfiguration,
    discovery: OidcDiscovery,
    nonce: string,
    providerKey: string,
    now = Date.now()
): Promise<ValidatedOidcIdentity> {
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some((part) => !part))
        throw new OidcError('response', 'Encrypted or malformed ID tokens are not supported.')
    const header = jsonPart(parts[0])
    const claims = jsonPart(parts[1])
    const algorithm = String(header.alg || '')
    const kid = String(header.kid || '')
    if (!ALGORITHMS.has(algorithm) || !discovery.id_token_signing_alg_values_supported.includes(algorithm) || !kid) {
        throw new OidcError('response', 'The ID token algorithm or key id is not accepted.')
    }
    const key = await signingKey(config, discovery, kid)
    if (key.alg && key.alg !== algorithm) throw new OidcError('response', 'The signing key algorithm does not match the ID token.')
    if (
        ((algorithm === 'RS256' || algorithm === 'PS256') && key.kty !== 'RSA') ||
        (algorithm === 'ES256' && (key.kty !== 'EC' || key.crv !== 'P-256'))
    ) {
        throw new OidcError('response', 'The signing key type does not match the ID token algorithm.')
    }
    let publicKey
    try {
        publicKey = createPublicKey({ key: key as any, format: 'jwk' })
    } catch {
        throw new OidcError('response', 'The ID token signing key is invalid.')
    }
    const data = Buffer.from(`${parts[0]}.${parts[1]}`)
    const signature = Buffer.from(parts[2], 'base64url')
    const verifyAlgorithm = algorithm === 'ES256' ? 'sha256' : algorithm === 'PS256' ? 'sha256' : 'RSA-SHA256'
    const keyOptions: any =
        algorithm === 'PS256'
            ? { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
            : algorithm === 'ES256'
            ? { key: publicKey, dsaEncoding: 'ieee-p1363' }
            : publicKey
    if (!verifySignature(verifyAlgorithm, data, keyOptions, signature))
        throw new OidcError('response', 'The ID token signature is invalid.')
    const seconds = Math.floor(now / 1000)
    const exp = typeof claims.exp === 'number' ? claims.exp : Number.NaN
    const iat = typeof claims.iat === 'number' ? claims.iat : Number.NaN
    if (!Number.isFinite(exp) || !Number.isFinite(iat) || exp < seconds - 60 || iat > seconds + 60) {
        throw new OidcError('response', 'The ID token time claims are invalid.')
    }
    if (claims.iss !== config.issuer) throw new OidcError('response', 'The ID token issuer is invalid.')
    const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : typeof claims.aud === 'string' ? [claims.aud] : []
    if (!audiences.includes(config.clientId)) throw new OidcError('response', 'The ID token audience is invalid.')
    if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== config.clientId) {
        throw new OidcError('response', 'The ID token authorized party is invalid.')
    }
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce))
        throw new OidcError('response', 'The ID token nonce is invalid.')
    const subject = typeof claims.sub === 'string' ? claims.sub : ''
    if (!subject.trim()) throw new OidcError('response', 'The ID token subject is missing.')
    return {
        providerKey,
        subject,
        issuer: config.issuer,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        emailVerified: claims.email_verified === true ? true : claims.email_verified === false ? false : undefined,
        emailVerificationPresent: Object.prototype.hasOwnProperty.call(claims, 'email_verified'),
        xmsEdov: claims.xms_edov === true,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        authTime: typeof claims.auth_time === 'number' && Number.isFinite(claims.auth_time) ? claims.auth_time : undefined
    }
}

function safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
}

export async function completeOidcAuthorization(input: {
    dataSource: DataSource
    state: string
    code?: string
    error?: string
    responseIssuer?: string
    callbackUrl: string
    browserSession: string | null
    currentEpoch: number
    now?: number
}): Promise<{ envelope: OidcEnvelope; config: OidcConfiguration; identity: ValidatedOidcIdentity }> {
    const now = input.now ?? Date.now()
    const envelope = await consumeEnvelope(input.dataSource, input.state, now)
    if (input.error) throw new OidcError('denied', 'The identity provider denied sign-in.')
    if (!input.code) throw new OidcError('response', 'The authorization response has no code.')
    if (envelope.authEpoch !== input.currentEpoch) throw new OidcError('transaction', 'Authentication settings changed during sign-in.')
    if (envelope.initiatingSession && !safeEqual(envelope.initiatingSession, input.browserSession || '')) {
        throw new OidcError('transaction', 'This sign-in must finish in the browser that started it.')
    }
    if ((envelope.authorizationResponseIssuer || input.responseIssuer !== undefined) && input.responseIssuer !== envelope.expectedIssuer) {
        throw new OidcError('response', 'The authorization response issuer is invalid.')
    }
    const slot = envelope.purpose === 'test' ? 'draft' : 'active'
    const config = await readOidcConfiguration(input.dataSource, slot)
    if (!config || config.fingerprint !== envelope.configFingerprint) {
        throw new OidcError('transaction', 'OIDC configuration changed during sign-in.')
    }
    const discovery = (config.discovery || (await discoverOidc(config))) as unknown as OidcDiscovery
    const exchanged = await exchangeCode(config, discovery, input.code, envelope.verifier, input.callbackUrl)
    const idToken = typeof exchanged.value.id_token === 'string' ? exchanged.value.id_token : ''
    if (!idToken) throw new OidcError('response', 'The token response has no ID token.')
    const identity = await validateIdToken(idToken, config, discovery, envelope.nonce, envelope.providerKey, now)
    return { envelope, config, identity }
}

export function clearOidcCachesForTest(): void {
    jwksCache.clear()
    unknownKidRefresh.clear()
}
