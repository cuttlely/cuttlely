/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
jest.mock('@cuttlely/components', () => jest.requireActual('../../../components/src/httpSecurity'))

import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { DataSource, QueryRunner } from 'typeorm'
import type { IdentityStore } from './store'
import type { UserRow } from './types'
import { addOidcProvider } from './schemaMigration'
import { oidcConfigurationFingerprint, oidcProviderKey, OidcConfiguration, resolveOidcUser, saveOidcDraft } from './oidcStore'
import {
    beginOidcAuthorization,
    checkOidcConfiguration,
    clearOidcCachesForTest,
    completeOidcAuthorization,
    decryptOidcEnvelope,
    discoverOidc,
    oidcCallbackError,
    oidcReauthenticationIsRecent,
    validateIdToken
} from './oidcProvider'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
    }
}

function database(): { source: DataSource; close(): void } {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE identity_authentication_switch_stage (id text PRIMARY KEY)')
    let active = false
    const run = async (sql: string, params: unknown[] = []) => {
        const statement = db.prepare(sql)
        if (/^\s*(select|pragma|with)\b/i.test(sql)) return statement.all(...params)
        statement.run(...params)
        return []
    }
    const runner = {
        connection: { options: { type: 'sqlite' } },
        connect: async () => undefined,
        release: async () => undefined,
        query: run,
        startTransaction: async () => {
            db.exec('BEGIN IMMEDIATE')
            active = true
        },
        commitTransaction: async () => {
            db.exec('COMMIT')
            active = false
        },
        rollbackTransaction: async () => {
            db.exec('ROLLBACK')
            active = false
        },
        get isTransactionActive() {
            return active
        }
    } as unknown as QueryRunner
    return {
        source: { options: { type: 'sqlite' }, createQueryRunner: () => runner, query: run } as unknown as DataSource,
        close: () => db.close()
    }
}

type Claims = Record<string, unknown>

class TestIdp {
    private readonly first = generateKeyPairSync('rsa', { modulusLength: 2048 })
    private readonly second = generateKeyPairSync('rsa', { modulusLength: 2048 })
    clientId = 'test-client'
    clientSecret = randomBytes(32).toString('base64url')
    readonly server = createServer((request, response) => void this.handle(request, response))
    issuer = ''
    discoveryMode: 'normal' | 'malformed' | 'redirect' = 'normal'
    key: 'first' | 'second' = 'first'
    nonce = ''
    claims: Partial<Claims> = {}
    userInfo: Record<string, unknown> | null = null
    tokenAuthMethods = ['client_secret_post']
    authorizationResponseIssuerSupported = true
    lastTokenBody = ''
    lastTokenAuthorization = ''
    lastUserInfoAuthorization = ''
    lastAccessToken = ''

    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => reject(error)
            this.server.once('error', failed)
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', failed)
                resolve()
            })
        })
        this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    }

    async stop(): Promise<void> {
        if (!this.server.listening) return
        await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())))
    }

    discovery(): Record<string, unknown> {
        const base = this.issuer.replace(/\/+$/, '')
        return {
            issuer: this.issuer,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            jwks_uri: `${base}/jwks`,
            userinfo_endpoint: `${base}/userinfo`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: this.tokenAuthMethods,
            ...(this.authorizationResponseIssuerSupported ? { authorization_response_iss_parameter_supported: true } : {})
        }
    }

    token(overrides: Partial<Claims> = {}, algorithm = 'RS256', kid = this.key): string {
        const now = Math.floor(Date.now() / 1000)
        const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: 'JWT', kid })).toString('base64url')
        const payload = Buffer.from(
            JSON.stringify({
                iss: this.issuer,
                aud: this.clientId,
                sub: 'subject-1',
                email: 'ada@example.com',
                email_verified: true,
                nonce: this.nonce,
                iat: now,
                exp: now + 300,
                ...this.claims,
                ...overrides
            })
        ).toString('base64url')
        const input = `${header}.${payload}`
        if (algorithm === 'none') return `${input}.unsigned`
        if (algorithm === 'HS256') return `${input}.${createHmac('sha256', 'not-a-provider-key').update(input).digest('base64url')}`
        const pair = kid === 'second' ? this.second : this.first
        return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`
    }

    private json(response: ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
        response.writeHead(200, { 'content-type': 'application/json', ...headers })
        response.end(JSON.stringify(body))
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = new URL(request.url || '/', this.issuer).pathname
        if (path === '/.well-known/openid-configuration') {
            if (this.discoveryMode === 'redirect') {
                response.writeHead(302, { location: `${this.issuer}/discovery-copy` })
                return void response.end()
            }
            return this.json(response, this.discoveryMode === 'malformed' ? { issuer: this.issuer } : this.discovery())
        }
        if (path === '/jwks') {
            const pair = this.key === 'first' ? this.first : this.second
            const key = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
            return this.json(response, { keys: [{ ...key, kid: this.key, use: 'sig', alg: 'RS256' }] }, { 'cache-control': 'max-age=3600' })
        }
        if (path === '/token') {
            this.lastTokenAuthorization = String(request.headers.authorization || '')
            this.lastTokenBody = await new Promise<string>((resolve) => {
                let body = ''
                request.setEncoding('utf8')
                request.on('data', (part) => (body += part))
                request.on('end', () => resolve(body))
            })
            this.lastAccessToken = randomBytes(32).toString('base64url')
            return this.json(response, {
                id_token: this.token(),
                access_token: this.lastAccessToken,
                refresh_token: randomBytes(32).toString('base64url')
            })
        }
        if (path === '/userinfo') {
            this.lastUserInfoAuthorization = String(request.headers.authorization || '')
            return this.json(response, this.userInfo || { sub: 'subject-1' })
        }
        response.writeHead(404)
        response.end()
    }
}

function configuration(idp: TestIdp, privateIssuerHosts = ['127.0.0.1']): OidcConfiguration {
    const safe = {
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecretEnvVar: 'CUTTLELY_TEST_OIDC_CLIENT_SECRET',
        trustMissingEmailVerification: false,
        privateIssuerHosts
    }
    return {
        slot: 'active',
        ...safe,
        fingerprint: oidcConfigurationFingerprint(safe),
        discovery: null,
        health: 'ready',
        healthError: null,
        checkedAt: null,
        testedFingerprint: null,
        testedAt: null,
        testResult: null,
        version: 1
    }
}

function identityStore(users: UserRow[]): IdentityStore {
    return {
        countUsers: async () => users.length,
        findUsersByEmail: async (email: string) => users.filter((candidate) => candidate.email.toLowerCase() === email.toLowerCase()),
        sessionFor: async () => null,
        acceptInvite: async () => 'invalid',
        createOwner: async () => {
            throw new Error('not used')
        }
    } as unknown as IdentityStore
}

describe('generic OIDC provider', () => {
    let idp: TestIdp
    const savedEnvironment: Record<string, string | undefined> = {}

    beforeEach(async () => {
        clearOidcCachesForTest()
        idp = new TestIdp()
        await idp.start()
        for (const name of ['TOKEN_HASH_SECRET', 'CUTTLELY_TEST_OIDC_CLIENT_SECRET']) savedEnvironment[name] = process.env[name]
        process.env.TOKEN_HASH_SECRET = randomBytes(48).toString('base64url')
        process.env.CUTTLELY_TEST_OIDC_CLIENT_SECRET = idp.clientSecret
    })

    afterEach(async () => {
        await idp.stop()
        for (const [name, value] of Object.entries(savedEnvironment)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })

    it('validates discovery only through an explicitly allowed private issuer host', async () => {
        await expect(checkOidcConfiguration(configuration(idp))).resolves.toMatchObject({ issuer: idp.issuer })
        await expect(discoverOidc(configuration(idp, []))).rejects.toThrow('must use https')
        idp.discoveryMode = 'malformed'
        await expect(discoverOidc(configuration(idp))).rejects.toThrow('required endpoint')
        idp.discoveryMode = 'redirect'
        await expect(discoverOidc(configuration(idp))).rejects.toMatchObject({ category: 'upstream' })
    })

    it('requires HTTPS callbacks except for the three local development hosts', () => {
        expect(oidcCallbackError('https://app.example/api/v1/auth/oidc/callback')).toBeNull()
        expect(oidcCallbackError('http://localhost:3000/api/v1/auth/oidc/callback')).toBeNull()
        expect(oidcCallbackError('http://127.0.0.1:3000/api/v1/auth/oidc/callback')).toBeNull()
        expect(oidcCallbackError('http://[::1]:3000/api/v1/auth/oidc/callback')).toBeNull()
        expect(oidcCallbackError('http://127.0.0.2:3000/api/v1/auth/oidc/callback')).toContain('APP_URL')
        expect(oidcCallbackError('http://app.example/api/v1/auth/oidc/callback')).toContain('HTTPS')
    })

    it('preserves an issuer that ends in a slash', async () => {
        idp.issuer = `${idp.issuer}/`
        const config = configuration(idp)
        await expect(discoverOidc(config)).resolves.toMatchObject({ issuer: idp.issuer })
    })

    it('form-encodes the client credentials used by client_secret_basic', async () => {
        idp.clientId = 'client%: value'
        idp.clientSecret = 'secret%: value'
        idp.tokenAuthMethods = ['client_secret_basic']
        process.env.CUTTLELY_TEST_OIDC_CLIENT_SECRET = idp.clientSecret
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const config = configuration(idp)
        const discovery = await checkOidcConfiguration(config)
        await saveOidcDraft(
            db.source,
            {
                issuer: config.issuer,
                clientId: config.clientId,
                clientSecretEnvVar: config.clientSecretEnvVar,
                trustMissingEmailVerification: false,
                privateIssuerHosts: config.privateIssuerHosts,
                fingerprint: config.fingerprint,
                discovery: discovery as unknown as Record<string, unknown>,
                health: 'ready',
                healthError: null,
                checkedAt: new Date().toISOString()
            },
            0
        )
        await db.source.query('UPDATE identity_oidc_configuration SET slot = ? WHERE slot = ?', ['active', 'draft'])
        const begun = await beginOidcAuthorization({
            dataSource: db.source,
            slot: 'active',
            installationId: 'installation',
            authenticationEpoch: 1,
            callbackUrl: 'https://app.example/api/v1/auth/oidc/callback',
            redirectTarget: '/',
            purpose: 'signin'
        })
        idp.nonce = new URL(begun.url).searchParams.get('nonce') || ''
        await completeOidcAuthorization({
            dataSource: db.source,
            state: begun.state,
            code: 'code',
            responseIssuer: idp.issuer,
            callbackUrl: begun.callbackUrl,
            browserNonce: begun.browserNonce,
            currentEpoch: 1
        })
        const encodedId = new URLSearchParams([['value', idp.clientId]]).toString().slice('value='.length)
        const encodedSecret = new URLSearchParams([['value', idp.clientSecret]]).toString().slice('value='.length)
        expect(idp.lastTokenAuthorization).toBe(`Basic ${Buffer.from(`${encodedId}:${encodedSecret}`).toString('base64')}`)
        expect(new URLSearchParams(idp.lastTokenBody).get('redirect_uri')).toBe(begun.callbackUrl)
        db.close()
    })

    it('refuses an unreachable issuer with a normalized upstream error', async () => {
        const config = configuration(idp)
        await idp.stop()
        await expect(discoverOidc(config)).rejects.toMatchObject({ category: 'upstream' })
    })

    it('validates claims and rejects issuer, audience, azp, time, nonce, and unsafe algorithms', async () => {
        const config = configuration(idp)
        const discovery = await checkOidcConfiguration(config)
        idp.nonce = 'expected-nonce'
        await expect(validateIdToken(idp.token(), config, discovery, idp.nonce, 'provider')).resolves.toMatchObject({
            subject: 'subject-1',
            email: 'ada@example.com'
        })
        const now = Math.floor(Date.now() / 1000)
        const cases: Array<[string, Partial<Claims>, string]> = [
            ['issuer', { iss: 'https://other.example' }, 'issuer'],
            ['audience', { aud: 'other-client' }, 'audience'],
            ['azp', { aud: ['test-client', 'other-client'], azp: 'other-client' }, 'authorized party'],
            ['stale', { exp: now - 61 }, 'time claims'],
            ['future', { iat: now + 61 }, 'time claims'],
            ['nonce', { nonce: 'wrong' }, 'nonce']
        ]
        for (const [, claims, message] of cases) {
            await expect(validateIdToken(idp.token(claims), config, discovery, idp.nonce, 'provider')).rejects.toThrow(message)
        }
        await expect(validateIdToken(idp.token({}, 'none'), config, discovery, idp.nonce, 'provider')).rejects.toThrow('algorithm')
        await expect(validateIdToken(idp.token({}, 'HS256'), config, discovery, idp.nonce, 'provider')).rejects.toThrow('algorithm')
    })

    it('refreshes JWKS once when a new key id appears', async () => {
        const config = configuration(idp)
        const discovery = await checkOidcConfiguration(config)
        idp.nonce = 'nonce'
        idp.key = 'second'
        await expect(validateIdToken(idp.token(), config, discovery, idp.nonce, 'provider')).resolves.toMatchObject({
            subject: 'subject-1'
        })
    })

    it('links an Entra ID-token email with xms_edov when UserInfo omits assurance', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const issuer = 'https://login.microsoftonline.com/tenant/v2.0'
        const safe = {
            issuer,
            clientId: idp.clientId,
            clientSecretEnvVar: 'CUTTLELY_TEST_OIDC_CLIENT_SECRET',
            trustMissingEmailVerification: false,
            privateIssuerHosts: ['127.0.0.1']
        }
        const fingerprint = oidcConfigurationFingerprint(safe)
        const discovery = { ...idp.discovery(), issuer }
        await saveOidcDraft(
            db.source,
            {
                ...safe,
                fingerprint,
                discovery,
                health: 'ready',
                healthError: null,
                checkedAt: new Date().toISOString()
            },
            0
        )
        await db.source.query('UPDATE identity_oidc_configuration SET slot = ? WHERE slot = ?', ['active', 'draft'])

        idp.issuer = issuer
        idp.claims = { email: 'ada@example.com', email_verified: undefined, xms_edov: true }
        idp.userInfo = { sub: 'subject-1', email: 'ada@example.com' }
        const begun = await beginOidcAuthorization({
            dataSource: db.source,
            slot: 'active',
            installationId: 'installation',
            authenticationEpoch: 1,
            callbackUrl: 'https://app.example/api/v1/auth/oidc/callback',
            redirectTarget: '/',
            purpose: 'signin'
        })
        idp.nonce = new URL(begun.url).searchParams.get('nonce') || ''
        const completed = await completeOidcAuthorization({
            dataSource: db.source,
            state: begun.state,
            code: 'code',
            responseIssuer: issuer,
            callbackUrl: begun.callbackUrl,
            browserNonce: begun.browserNonce,
            currentEpoch: 1
        })
        const user: UserRow = {
            id: 'user-1',
            email: 'ada@example.com',
            name: 'Ada',
            externalId: null,
            credential: null,
            status: 'active'
        }
        await expect(resolveOidcUser(db.source, identityStore([user]), completed.identity, { trustMissing: false })).resolves.toMatchObject(
            {
                ok: true,
                user: { id: 'user-1' },
                basis: 'xms_edov'
            }
        )
        expect(idp.lastUserInfoAuthorization).toBe('')
        db.close()
    })

    it('refuses a non-RFC-9207 transaction at another issuer callback before the token request', async () => {
        idp.authorizationResponseIssuerSupported = false
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const config = configuration(idp)
        const discovery = await checkOidcConfiguration(config)
        await saveOidcDraft(
            db.source,
            {
                issuer: config.issuer,
                clientId: config.clientId,
                clientSecretEnvVar: config.clientSecretEnvVar,
                trustMissingEmailVerification: false,
                privateIssuerHosts: config.privateIssuerHosts,
                fingerprint: config.fingerprint,
                discovery: discovery as unknown as Record<string, unknown>,
                health: 'ready',
                healthError: null,
                checkedAt: new Date().toISOString()
            },
            0
        )
        await db.source.query('UPDATE identity_oidc_configuration SET slot = ? WHERE slot = ?', ['active', 'draft'])

        const start = () =>
            beginOidcAuthorization({
                dataSource: db.source,
                slot: 'active',
                installationId: 'installation',
                authenticationEpoch: 1,
                callbackUrl: 'https://app.example/api/v1/auth/oidc/callback',
                redirectTarget: '/',
                purpose: 'signin'
            })
        const begun = await start()
        const otherIssuerCallback = new URL(begun.callbackUrl)
        otherIssuerCallback.searchParams.set('provider', oidcProviderKey('installation', 'https://other.example', 'other-client'))
        idp.lastTokenBody = ''
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: begun.state,
                code: 'code',
                callbackUrl: otherIssuerCallback.toString(),
                browserNonce: begun.browserNonce,
                currentEpoch: 1
            })
        ).rejects.toThrow('response callback')
        expect(idp.lastTokenBody).toBe('')

        const accepted = await start()
        idp.nonce = new URL(accepted.url).searchParams.get('nonce') || ''
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: accepted.state,
                code: 'code',
                callbackUrl: accepted.callbackUrl,
                browserNonce: accepted.browserNonce,
                currentEpoch: 1
            })
        ).resolves.toMatchObject({ identity: { issuer: idp.issuer, subject: 'subject-1' } })
        expect(new URLSearchParams(idp.lastTokenBody).get('redirect_uri')).toBe(accepted.callbackUrl)
        db.close()
    })

    it('uses a single-use encrypted transaction and rejects state, epoch, denial, and response issuer errors', async () => {
        const db = database()
        await addOidcProvider(db.source.createQueryRunner())
        const config = configuration(idp)
        const discovery = await checkOidcConfiguration(config)
        const draft = await saveOidcDraft(
            db.source,
            {
                issuer: config.issuer,
                clientId: config.clientId,
                clientSecretEnvVar: config.clientSecretEnvVar,
                trustMissingEmailVerification: false,
                privateIssuerHosts: config.privateIssuerHosts,
                fingerprint: config.fingerprint,
                discovery: discovery as unknown as Record<string, unknown>,
                health: 'ready',
                healthError: null,
                checkedAt: new Date().toISOString()
            },
            0
        )
        await db.source.query('UPDATE identity_oidc_configuration SET slot = ? WHERE slot = ?', ['active', 'draft'])

        const start = async (purpose: 'signin' | 'test' | 'reauth' | 'invite' = 'signin') => {
            const begun = await beginOidcAuthorization({
                dataSource: db.source,
                slot: 'active',
                installationId: 'installation',
                authenticationEpoch: 7,
                callbackUrl: 'https://app.example/api/v1/auth/oidc/callback',
                redirectTarget: '/',
                purpose
            })
            const url = new URL(begun.url)
            idp.nonce = url.searchParams.get('nonce') || ''
            expect(url.searchParams.get('code_challenge_method')).toBe('S256')
            expect(url.searchParams.get('scope')).toBe('openid email profile')
            return begun
        }

        const reauthentication = await start('reauth')
        expect(new URL(reauthentication.url).searchParams.get('prompt')).toBe('login')
        expect(new URL(reauthentication.url).searchParams.get('max_age')).toBe('0')
        const ordinary = await start()
        expect(new URL(ordinary.url).searchParams.has('prompt')).toBe(false)
        expect(new URL(ordinary.url).searchParams.has('max_age')).toBe(false)
        const storedTransactions = (await db.source.query('SELECT envelope FROM identity_oidc_transaction')) as Array<{ envelope: string }>
        const ordinaryEnvelope = storedTransactions.map((row) => decryptOidcEnvelope(row.envelope)).find((row) => row.purpose === 'signin')
        expect(ordinaryEnvelope?.browserNonceHash).toBe(createHash('sha256').update(ordinary.browserNonce).digest('base64url'))
        expect(JSON.stringify(ordinaryEnvelope)).not.toContain(ordinary.browserNonce)

        for (const purpose of ['signin', 'invite', 'test', 'reauth'] as const) {
            const bound = await start(purpose)
            idp.lastTokenBody = ''
            await expect(
                completeOidcAuthorization({
                    dataSource: db.source,
                    state: bound.state,
                    code: 'code',
                    callbackUrl: bound.callbackUrl,
                    browserNonce: 'different-browser',
                    currentEpoch: 7
                })
            ).rejects.toThrow('browser that started')
            expect(idp.lastTokenBody).toBe('')
        }

        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: 'wrong-state',
                code: 'code',
                callbackUrl: 'https://app.example/api/v1/auth/oidc/callback',
                browserNonce: null,
                currentEpoch: 7
            })
        ).rejects.toMatchObject({ category: 'transaction' })

        const wrongCallbackError = await start()
        const wrongCallbackUrl = new URL(wrongCallbackError.callbackUrl)
        wrongCallbackUrl.searchParams.set('provider', 'different-provider')
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: wrongCallbackError.state,
                error: 'access_denied',
                responseIssuer: idp.issuer,
                callbackUrl: wrongCallbackUrl.toString(),
                browserNonce: wrongCallbackError.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toMatchObject({ category: 'response', outcome: 'authorization_response_invalid' })

        const wrongIssuerError = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: wrongIssuerError.state,
                error: 'access_denied',
                responseIssuer: 'https://other.example',
                callbackUrl: wrongIssuerError.callbackUrl,
                browserNonce: wrongIssuerError.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toMatchObject({ category: 'response', outcome: 'authorization_response_invalid' })

        const missingIssuerError = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: missingIssuerError.state,
                error: 'access_denied',
                callbackUrl: missingIssuerError.callbackUrl,
                browserNonce: missingIssuerError.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toMatchObject({ category: 'response', outcome: 'authorization_response_invalid' })

        const denied = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: denied.state,
                error: 'access_denied',
                responseIssuer: idp.issuer,
                callbackUrl: denied.callbackUrl,
                browserNonce: denied.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toMatchObject({ category: 'denied' })
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: denied.state,
                code: 'replay-code',
                callbackUrl: denied.callbackUrl,
                browserNonce: denied.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toMatchObject({ category: 'transaction' })

        const oldEpoch = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: oldEpoch.state,
                code: 'code',
                callbackUrl: oldEpoch.callbackUrl,
                browserNonce: oldEpoch.browserNonce,
                currentEpoch: 8
            })
        ).rejects.toThrow('settings changed')

        const browserBound = await start('test')
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: browserBound.state,
                code: 'code',
                callbackUrl: browserBound.callbackUrl,
                browserNonce: 'other-browser',
                currentEpoch: 7
            })
        ).rejects.toThrow('browser that started')

        const wrongIssuer = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: wrongIssuer.state,
                code: 'code',
                responseIssuer: 'https://other.example',
                callbackUrl: wrongIssuer.callbackUrl,
                browserNonce: wrongIssuer.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toThrow('response issuer')
        expect(idp.lastTokenBody).toBe('')

        const missingIssuer = await start()
        idp.lastTokenBody = ''
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: missingIssuer.state,
                code: 'code',
                callbackUrl: missingIssuer.callbackUrl,
                browserNonce: missingIssuer.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toThrow('response issuer is missing')
        expect(idp.lastTokenBody).toBe('')

        const changedConfig = await start()
        await db.source.query('UPDATE identity_oidc_configuration SET fingerprint = ? WHERE slot = ?', ['changed', 'active'])
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: changedConfig.state,
                code: 'code',
                responseIssuer: idp.issuer,
                callbackUrl: changedConfig.callbackUrl,
                browserNonce: changedConfig.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toThrow('configuration changed')
        await db.source.query('UPDATE identity_oidc_configuration SET fingerprint = ? WHERE slot = ?', [config.fingerprint, 'active'])

        idp.claims = { email: undefined, email_verified: undefined }
        idp.userInfo = { sub: 'subject-1', email: 'userinfo@example.com', email_verified: true }
        const success = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: success.state,
                code: 'one-time-code',
                responseIssuer: idp.issuer,
                callbackUrl: success.callbackUrl,
                browserNonce: success.browserNonce,
                currentEpoch: 7
            })
        ).resolves.toMatchObject({
            config: { fingerprint: draft.fingerprint },
            identity: { subject: 'subject-1', email: 'userinfo@example.com', emailVerified: true }
        })
        expect(idp.lastTokenBody).toContain('code=one-time-code')
        expect(idp.lastTokenBody).toContain('code_verifier=')
        expect(new URLSearchParams(idp.lastTokenBody).get('redirect_uri')).toBe(success.callbackUrl)
        expect(idp.lastUserInfoAuthorization).toBe(`Bearer ${idp.lastAccessToken}`)

        idp.claims = { email: 'id-token@example.com', email_verified: undefined }
        idp.userInfo = { sub: 'subject-1', email_verified: true }
        const incompleteUserInfo = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: incompleteUserInfo.state,
                code: 'code',
                responseIssuer: idp.issuer,
                callbackUrl: incompleteUserInfo.callbackUrl,
                browserNonce: incompleteUserInfo.browserNonce,
                currentEpoch: 7
            })
        ).resolves.toMatchObject({ identity: { email: undefined, emailVerified: true, emailVerificationPresent: true } })

        idp.claims = { email: 'id-token@example.com', email_verified: undefined }
        idp.userInfo = { sub: 'subject-1', email: 'userinfo@example.com', email_verified: true }
        const userInfoPair = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: userInfoPair.state,
                code: 'code',
                responseIssuer: idp.issuer,
                callbackUrl: userInfoPair.callbackUrl,
                browserNonce: userInfoPair.browserNonce,
                currentEpoch: 7
            })
        ).resolves.toMatchObject({
            identity: { email: 'userinfo@example.com', emailVerified: true, emailVerificationPresent: true }
        })

        idp.claims = { email: 'id-token@example.com', email_verified: false }
        idp.userInfo = { sub: 'subject-1', email: 'id-token@example.com', email_verified: true }
        idp.lastUserInfoAuthorization = ''
        const idTokenPair = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: idTokenPair.state,
                code: 'code',
                responseIssuer: idp.issuer,
                callbackUrl: idTokenPair.callbackUrl,
                browserNonce: idTokenPair.browserNonce,
                currentEpoch: 7
            })
        ).resolves.toMatchObject({
            identity: { email: 'id-token@example.com', emailVerified: false, emailVerificationPresent: true }
        })
        expect(idp.lastUserInfoAuthorization).toBe('')

        idp.claims = { email: undefined, email_verified: undefined }
        idp.userInfo = { sub: 'subject-1', email: 'userinfo@example.com', email_verified: false }
        const falseUserInfoPair = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: falseUserInfoPair.state,
                code: 'code',
                responseIssuer: idp.issuer,
                callbackUrl: falseUserInfoPair.callbackUrl,
                browserNonce: falseUserInfoPair.browserNonce,
                currentEpoch: 7
            })
        ).resolves.toMatchObject({
            identity: { email: 'userinfo@example.com', emailVerified: false, emailVerificationPresent: true }
        })

        const completeReauthentication = async (authTime?: number) => {
            idp.claims = { auth_time: authTime, email: 'ada@example.com', email_verified: true }
            idp.userInfo = null
            const begun = await start('reauth')
            const completed = await completeOidcAuthorization({
                dataSource: db.source,
                state: begun.state,
                code: 'code',
                responseIssuer: idp.issuer,
                callbackUrl: begun.callbackUrl,
                browserNonce: begun.browserNonce,
                currentEpoch: 7
            })
            return oidcReauthenticationIsRecent(completed.envelope, completed.identity)
        }
        await expect(completeReauthentication()).resolves.toBe(false)
        await expect(completeReauthentication(Math.floor((Date.now() - 61_000) / 1000))).resolves.toBe(false)
        await expect(completeReauthentication(Math.floor((Date.now() - 30_000) / 1000))).resolves.toBe(true)

        idp.userInfo = { sub: 'different-subject', email: 'userinfo@example.com', email_verified: true }
        idp.claims = { email: undefined, email_verified: undefined }
        const mismatchedUserInfo = await start()
        await expect(
            completeOidcAuthorization({
                dataSource: db.source,
                state: mismatchedUserInfo.state,
                code: 'code',
                responseIssuer: idp.issuer,
                callbackUrl: mismatchedUserInfo.callbackUrl,
                browserNonce: mismatchedUserInfo.browserNonce,
                currentEpoch: 7
            })
        ).rejects.toThrow('UserInfo subject')
        db.close()
    })
})
