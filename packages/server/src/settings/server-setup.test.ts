import cookieParser from 'cookie-parser'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import * as authenticationState from '../identity/authenticationState'
import {
    announceFirstRunSetup,
    bindSetupCodeStore,
    consumeSetupCode,
    firstRunSetupCode,
    forgetIssuedSetupCode,
    issuedSetupHmac,
    noteSetupFailure,
    reissueExpiredSetupCode,
    reissueExpiredSetupIfOpen,
    resetFirstRunSetupCode,
    runSetupCodeWatch,
    serverSetupLink,
    SETUP_CODE_TTL_MS,
    setupCodeHmac,
    setupCodeMatches,
    setupCodeReady,
    setupCodeVerdict,
    watchFirstRunSetup
} from '../identity/setupCode'
import { resetSetupFailures, setupFailureLimited } from '../identity/setupLimit'
import { CreateOwnerInput, CreateOwnerOptions, SetupCodeRejected, UserRow } from '../identity/types'
import { StartState } from './apply'
import { AuthKitDeps, AuthKitPort, resetAuthKitTests } from './authkit'
import { readHistory } from './history'
import { endSetupSessions, SETUP_COOKIE_PATHS } from './setup-session'
import { readSettingsFile, writeSettingsFile } from './store'

jest.mock('./bootstrap', () => ({
    startState: { dir: '', hostKeys: [], atStart: {}, applied: [], unreadable: [], problems: [] }
}))

import { authKitTestCallback, isAuthKitTestCallback, setAuthKitDeps, setServerSettingsDeps } from '../routes/server-settings/index'
import setupRouter, { setSetupUsers } from '../routes/server-setup/index'

// Made-up people and obviously fake values only. No real WorkOS account is used anywhere in these tests.
const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const FAKE = {
    WORKOS_API_KEY: 'sk_test_obviously_fake_0000',
    WORKOS_CLIENT_ID: 'client_obviously_fake_0000',
    WORKOS_REDIRECT_URI: 'https://rosas-bakery.example/api/v1/auth/callback',
    WORKOS_COOKIE_PASSWORD: 'obviously-fake-seal-0000000000000000000000',
    CUTTLELY_BOOTSTRAP_EMAIL: 'rosa@rosas-bakery.example'
}
const GOOD_PASSWORD = 'Made-Up-Pass-123!'
const INTERNAL = { 'x-request-from': 'internal' }

function setCookies(header: string | string[] | undefined): string[] {
    if (Array.isArray(header)) return header
    return header ? [header] : []
}

function cookiePathList(header: string | string[] | undefined): string[] {
    return setCookies(header).flatMap((cookie) => {
        const match = cookie.match(/(?:^|; )Path=([^;]*)/)
        return match ? [match[1]] : []
    })
}

/** Browser path match for a cookie Path attribute. */
function requestPathMatchesCookie(cookiePath: string, requestPath: string): boolean {
    if (requestPath === cookiePath) return true
    const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`
    return requestPath.startsWith(prefix)
}

/** Cookie pairs a browser would send for requestPath. */
function browserCookie(header: string | string[] | undefined, requestPath: string): string {
    return setCookies(header)
        .filter((cookie) => {
            const match = cookie.match(/(?:^|; )Path=([^;]*)/)
            const cookiePath = match ? match[1] : '/'
            return requestPathMatchesCookie(cookiePath, requestPath)
        })
        .map((cookie) => cookie.split(';')[0])
        .join('; ')
}

function expectSetupHeaders(headers: Record<string, unknown>): void {
    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'")
}

const BAD_CODE = 'This setup code is not right. Copy it again from the server log.'
const EXPIRED_CODE = 'This setup code has expired. A new code was printed in the server log.'

let data: string
let dir: string
let env: Record<string, string | undefined>
let state: StartState
let now: number
let created: CreateOwnerInput[]
let lastOwnerOptions: CreateOwnerOptions | undefined
let exchangeUser: { id: string; email: string; emailVerified: boolean; name: string | null }

function users() {
    return {
        countUsers: async () => created.length,
        createOwner: async (input: CreateOwnerInput, options?: CreateOwnerOptions) => {
            if (options?.consumeSetupHmac) {
                const consumed = await consumeSetupCode(options.consumeSetupHmac, options.now ?? Date.now())
                if (!consumed) throw new SetupCodeRejected()
            }
            created.push(input)
            lastOwnerOptions = options
            return {
                id: `user-${created.length}`,
                email: input.email,
                name: input.name,
                status: 'active',
                externalId: null
            } as unknown as UserRow
        },
        findUserByExternalId: async () => null,
        findUsersByEmail: async () => []
    }
}

function fakeKit(): AuthKitDeps {
    const port: AuthKitPort = {
        authorizationUrl: ({ clientId, state: s }) => `https://authkit.example/authorize?client_id=${clientId}&state=${s}`,
        exchange: async ({ cookiePassword }) => ({ user: exchangeUser, sealed: `sealed:${cookiePassword}` }),
        unseal: async ({ sealed, cookiePassword }) => sealed === `sealed:${cookiePassword}`,
        checkKey: async () => 'unreachable'
    }
    return { port, users, now: () => now }
}

function server(trustProxy: boolean | number = false) {
    const app = express()
    if (trustProxy !== false) app.set('trust proxy', trustProxy)
    app.use(express.json())
    app.use(cookieParser())
    app.use('/api/v1/server-setup', setupRouter)
    app.get('/api/v1/auth/callback', (req, res, next) => {
        if (isAuthKitTestCallback(req)) return void authKitTestCallback(req, res, next)
        res.status(418).send('normal sign-in')
    })
    return app
}

async function opened() {
    const agent = request.agent(server())
    const res = await agent.post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })
    expect(res.status).toBe(200)
    return agent
}

beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-setup-'))
    dir = path.join(data, 'settings')
    env = { CUTTLELY_DATA_DIR: data, RENDER: 'true', RENDER_EXTERNAL_URL: 'https://rosas-bakery.example' }
    state = {
        dir,
        ignored: false,
        byStartScript: false,
        hostKeys: [],
        atStart: {},
        applied: [],
        unreadable: [],
        problems: [],
        rawAtStart: null
    }
    now = Date.now()
    created = []
    lastOwnerOptions = undefined
    exchangeUser = { id: 'user_fake_1', email: 'rosa@rosas-bakery.example', emailVerified: true, name: 'Rosa' }
    resetFirstRunSetupCode()
    resetAuthKitTests()
    endSetupSessions()
    setServerSettingsDeps(() => ({ env, state, key: async () => KEY }))
    setAuthKitDeps(fakeKit)
    setSetupUsers(users)
})

afterAll(() => resetFirstRunSetupCode())

describe('the setup link in the log', () => {
    it('is printed only when nobody can sign in, with the public address', async () => {
        const lines: string[] = []
        const log = (line: string) => lines.push(line)
        expect(await announceFirstRunSetup(3000, async () => 0, log, false, env)).toBe('setup')
        const block = lines.join('\n')
        expect(block).toContain('https://rosas-bakery.example/setup#code=')
        expect(block).toContain(serverSetupLink(3000, env))
        expect(block).toContain('works once')
        lines.length = 0
        // Accounts exist but nobody can sign in: no link (it would create nothing), only how to turn a method back on.
        expect(await announceFirstRunSetup(3000, async () => 1, log, false, env)).toBe('recover')
        expect(lines).toEqual([expect.stringContaining('nobody can sign in')])
        expect(lines[0]).not.toContain('code=')
        lines.length = 0
        const authKitOn = { ...env, ...FAKE }
        expect(await announceFirstRunSetup(3000, async () => 0, log, false, authKitOn)).toBe('none')
        expect(lines).toEqual([])
    })

    it('does not announce recovery while the durable OIDC method is active', async () => {
        const selected = jest.spyOn(authenticationState, 'selectedAuthenticationMethod').mockReturnValue('oidc')
        const lines: string[] = []
        try {
            expect(
                await announceFirstRunSetup(
                    3000,
                    async () => 1,
                    (line) => lines.push(line),
                    false,
                    env
                )
            ).toBe('none')
            expect(lines).toEqual([])
        } finally {
            selected.mockRestore()
        }
    })

    it('falls back to APP_URL, then this machine', () => {
        expect(serverSetupLink(3000, { APP_URL: 'https://flows.rosas-bakery.example/x' })).toMatch(
            /^https:\/\/flows\.rosas-bakery\.example\/setup#code=/
        )
        expect(serverSetupLink(3000, { APP_URL: 'not an address' })).toMatch(/^http:\/\/localhost:3000\/setup#code=/)
    })
})

describe('beginning setup', () => {
    it('names the service and does not reveal the code', async () => {
        env.CUTTLELY_SERVICE_NAME = 'bakery-web'
        const hint = await request(server()).get('/api/v1/server-setup/hint')
        expect(hint.status).toBe(200)
        expect(hint.body).toEqual({ serviceName: 'bakery-web', open: true })
        expect(JSON.stringify(hint.body)).not.toContain('code')
        env.CUTTLELY_SERVICE_NAME = 'bad name'
        expect((await request(server()).get('/api/v1/server-setup/hint')).body.serviceName).toBe('cuttlely')
    })

    it('opens the sign-in choice when no sign-in method is on', async () => {
        const res = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ next: 'choose' })
        expect(String(res.headers['set-cookie'])).toContain('cuttlely-setup')
        expect(String(res.headers['set-cookie'])).not.toContain(firstRunSetupCode())
    })

    it('opens the owner form when the password sign-in is already on, with no settings cookie', async () => {
        env.CUTTLELY_LOCAL_ADMIN = 'true'
        const res = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ next: 'owner' })
        expect(res.headers['set-cookie']).toBeUndefined()
    })

    it('awaits the code check and refuses a wrong code', async () => {
        const wrong = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: 'not-the-code' })
        expect(wrong.status).toBe(404)
        expect(wrong.body).toEqual({ code: 'BAD_CODE', message: BAD_CODE })
        expect(String(wrong.body.message)).not.toContain('setup link')
        const right = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(right.status).toBe(200)
        expect(right.body).toEqual({ next: 'choose' })
    })

    it('lets a wrong code be tried again and closes once an account exists', async () => {
        const wrong = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: 'not-the-code' })
        expect(wrong.status).toBe(404)
        expect(wrong.body.code).toBe('BAD_CODE')
        expect(wrong.body.message).toBe(BAD_CODE)
        created.push({ email: 'rosa@rosas-bakery.example', name: 'Rosa', credential: 'hash', externalId: null })
        const closed = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(closed.status).toBe(410)
        expect(closed.body.code).toBe('SETUP_CLOSED')
    })
})

describe('opening the link', () => {
    it('needs the right code and the app header, then sets a strict cookie', async () => {
        const app = server()
        expect((await request(app).post('/api/v1/server-setup/open').send({ code: firstRunSetupCode() })).status).toBe(401)
        const wrong = await request(app).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: 'wrong' })
        expect(wrong.status).toBe(404)
        expect(wrong.body.message).toBe(BAD_CODE)
        expect(String(wrong.body.message)).not.toContain('setup link')
        expect((await request(app).get('/api/v1/server-setup/state')).status).toBe(401)
        const res = await request(app).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(res.status).toBe(200)
        expect(res.headers['referrer-policy']).toBe('no-referrer')
        expect(res.headers['cache-control']).toBe('no-store')
        expect(res.headers['x-frame-options']).toBe('DENY')
        expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'")
        const cookies = setCookies(res.headers['set-cookie'])
        const cookie = cookies.join('\n')
        expect(cookie).toMatch(/cuttlely-setup=/)
        expect(cookie).toMatch(/HttpOnly/)
        expect(cookie).toMatch(/SameSite=Strict/)
        expect(cookie).not.toContain(firstRunSetupCode())
        expect(cookiePathList(cookies).sort()).toEqual(['/api/v1/auth/callback', '/api/v1/server-setup'])
    })

    it('is closed once an account exists or a sign-in method is on', async () => {
        const app = server()
        created.push({ email: 'someone@rosas-bakery.example', name: 'Someone', credential: null, externalId: null })
        const res = await request(app).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(res.status).toBe(410)
        expect(res.body.message).toBe('This server already has an account. Sign in instead.')
        expect(setupFailureLimited('127.0.0.1', Date.now())).toBe(false)
        created = []
        env.CUTTLELY_LOCAL_ADMIN = 'true'
        expect((await request(app).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })).status).toBe(410)
    })

    it('shows only Sign-in & identity, never a secret value', async () => {
        writeSettingsFile(dir, { WORKOS_API_KEY: FAKE.WORKOS_API_KEY }, { key: KEY, by: 'test' })
        const agent = await opened()
        const res = await agent.get('/api/v1/server-setup/state')
        expect(res.status).toBe(200)
        expect(new Set(res.body.settings.map((setting: { section: string }) => setting.section))).toEqual(new Set(['signin']))
        expect(res.body.install).toBe('render')
        expect(JSON.stringify(res.body)).not.toContain(FAKE.WORKOS_API_KEY)
        expect(res.body.settings.find((s: { key: string }) => s.key === 'WORKOS_API_KEY').secret).toEqual({ set: true, unreadable: false })
    })
})

describe('use a password for now', () => {
    it('checks the fields', async () => {
        const agent = await opened()
        const res = await agent.post('/api/v1/server-setup/owner').set(INTERNAL).send({ name: '', email: 'nope', password: 'short' })
        expect(res.status).toBe(400)
        expect(res.body.errors.map((error: { key: string }) => error.key)).toEqual(['name', 'email', 'password'])
        expect(created).toEqual([])
        expect(JSON.stringify(res.body)).not.toContain('short')
    })

    it('refuses an email with an empty domain label, and a long run of dots, without creating the owner', async () => {
        const agent = await opened()
        for (const email of ['rosa@bakery..example', 'rosa@.bakery.example', 'rosa@bakery.example.', `!@!.${'.'.repeat(240)}`]) {
            const res = await agent.post('/api/v1/server-setup/owner').set(INTERNAL).send({ name: 'Rosa', email, password: GOOD_PASSWORD })
            expect(res.status).toBe(400)
            expect(res.body.errors.map((error: { key: string }) => error.key)).toEqual(['email'])
        }
        expect(created).toEqual([])
    })

    it('creates the owner, turns the password sign-in on, and the link dies', async () => {
        const agent = await opened()
        const res = await agent
            .post('/api/v1/server-setup/owner')
            .set(INTERNAL)
            .send({ name: 'Rosa', email: 'rosa@rosas-bakery.example', password: GOOD_PASSWORD })
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ restarting: false, email: 'rosa@rosas-bakery.example' })
        expect(res.body.steps.length).toBeGreaterThan(0)
        expect(JSON.stringify(res.body)).not.toContain(GOOD_PASSWORD)
        expect(created).toHaveLength(1)
        expect(created[0].credential).not.toBe(GOOD_PASSWORD)
        expect(lastOwnerOptions?.consumeSetupHmac).toMatch(/^[0-9a-f]{64}$/i)
        expect(typeof lastOwnerOptions?.now).toBe('number')
        expect(lastOwnerOptions?.activateLocalAuthentication).toBe(true)
        expect(cookiePathList(res.headers['set-cookie']).sort()).toEqual(['/', '/api/v1/auth/callback', '/api/v1/server-setup'])
        expect(readSettingsFile(dir, KEY).values.CUTTLELY_LOCAL_ADMIN).toBe('true')
        expect(readHistory(dir).map((entry) => entry.by)).toContain('setup link')
        // Single use: the same code, the same browser, all closed.
        expect((await agent.get('/api/v1/server-setup/state')).status).toBe(401)
        created = []
        const again = await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(again.status).toBe(410)
        expect(again.body.message).toBe('This setup link has already been used. Sign in instead.')
        // Hashing the password and saving the settings took over 5 s once under a fully loaded unit run (under 0.1 s alone).
    }, 20000)

    it('limits code exchange failures by socket address when the forwarded address changes', async () => {
        const app = server(true)
        for (let i = 0; i < 10; i++) {
            const res = await request(app)
                .post('/api/v1/server-setup/open')
                .set(INTERNAL)
                .set('X-Forwarded-For', `198.51.100.${i}`)
                .send({ code: 'TESTCODE-wrong' })
            expect(res.status).toBe(404)
        }
        const blocked = await request(app)
            .post('/api/v1/server-setup/open')
            .set(INTERNAL)
            .set('X-Forwarded-For', '203.0.113.77')
            .send({ code: 'TESTCODE-wrong' })
        expect(blocked.status).toBe(429)
        expect(blocked.headers['referrer-policy']).toBe('no-referrer')
        expect(blocked.headers['cache-control']).toBe('no-store')
        expect(blocked.headers['x-frame-options']).toBe('DENY')
        expect(blocked.headers['content-security-policy']).toBe("frame-ancestors 'none'")
        const allowed = await request(app)
            .post('/api/v1/server-setup/open')
            .set(INTERNAL)
            .set('X-Forwarded-For', '203.0.113.78')
            .send({ code: firstRunSetupCode() })
        expect(allowed.status).toBe(200)
    })

    it('creates the owner from the stored code after this process loses its copy', async () => {
        const code = firstRunSetupCode()
        await setupCodeReady()
        forgetIssuedSetupCode()
        expect(issuedSetupHmac()).toBeNull()
        const agent = request.agent(server())
        const openedRes = await agent.post('/api/v1/server-setup/open').set(INTERNAL).send({ code })
        expect(openedRes.status).toBe(200)
        const res = await agent
            .post('/api/v1/server-setup/owner')
            .set(INTERNAL)
            .send({ name: 'Rosa', email: 'rosa@rosas-bakery.example', password: GOOD_PASSWORD })
        expect(res.status).toBe(200)
        expect(created).toHaveLength(1)
        expect(lastOwnerOptions?.consumeSetupHmac).toBe(setupCodeHmac(code))
        expect(await setupCodeMatches(code)).toBe(false)
        const second = await agent
            .post('/api/v1/server-setup/owner')
            .set(INTERNAL)
            .send({ name: 'Rosa', email: 'rosa2@rosas-bakery.example', password: GOOD_PASSWORD })
        expect(second.status).toBe(401)
        expect(created).toHaveLength(1)
        const again = await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code })
        expect(again.status).toBe(410)
        expect(again.body.message).toBe('This setup link has already been used. Sign in instead.')
    }, 20000)

    it('refuses owner creation when the stored code is no longer live', async () => {
        const code = firstRunSetupCode()
        await setupCodeReady()
        const hmac = setupCodeHmac(code) as string
        const agent = request.agent(server())
        expect((await agent.post('/api/v1/server-setup/open').set(INTERNAL).send({ code })).status).toBe(200)
        bindSetupCodeStore({
            read: async () => ({ codeHmac: hmac, issuedAt: 1, expiresAt: 1, consumedAt: null }),
            save: async () => 'kept',
            consume: async () => false
        })
        const res = await agent
            .post('/api/v1/server-setup/owner')
            .set(INTERNAL)
            .send({ name: 'Rosa', email: 'rosa@rosas-bakery.example', password: GOOD_PASSWORD })
        expect(res.status).toBe(410)
        expect(res.body.message).toBe('Open the setup link from the server log again.')
        expect(created).toEqual([])
        let values: Record<string, string> | undefined
        try {
            values = readSettingsFile(dir, KEY).values
        } catch {
            values = undefined
        }
        expect(values?.CUTTLELY_LOCAL_ADMIN).toBeUndefined()
    })

    it('is refused when the host sets the password sign-in', async () => {
        state.hostKeys = ['CUTTLELY_LOCAL_ADMIN']
        env.CUTTLELY_LOCAL_ADMIN = 'false'
        const agent = await opened()
        const res = await agent
            .post('/api/v1/server-setup/owner')
            .set(INTERNAL)
            .send({ name: 'Rosa', email: 'rosa@rosas-bakery.example', password: GOOD_PASSWORD })
        expect(res.status).toBe(409)
        expect(res.body.code).toBe('LOCKED')
        expect(created).toEqual([])
    })
})

describe('set up AuthKit from the link', () => {
    async function startTest(agent: ReturnType<typeof request.agent>, values: Record<string, string> = FAKE) {
        const res = await agent.post('/api/v1/server-setup/authkit/test').set(INTERNAL).send({ values })
        return res
    }

    it('needs the owner email', async () => {
        const agent = await opened()
        const res = await startTest(agent, { ...FAKE, CUTTLELY_BOOTSTRAP_EMAIL: '' })
        expect(res.status).toBe(400)
        expect(res.body.errors[0].key).toBe('CUTTLELY_BOOTSTRAP_EMAIL')
    })

    it('passes when the test sign-in is the owner email, then saves and closes the link', async () => {
        const agent = await opened()
        const started = await startTest(agent)
        expect(started.status).toBe(200)
        const testState = new URL(started.body.url).searchParams.get('state') as string
        const back = await agent.get('/api/v1/auth/callback').query({ state: testState, code: 'made-up-code' })
        expect(back.status).toBe(302)
        expect(back.headers.location).toBe('/setup?authkit=done')
        const status = await agent.get('/api/v1/server-setup/authkit/test')
        expect(status.body.status).toBe('passed')
        expect(status.body.steps.map((step: { label: string }) => step.label)).toContain('Becomes the owner')
        expect(JSON.stringify(status.body)).not.toContain(FAKE.WORKOS_API_KEY)
        const applied = await agent.post('/api/v1/server-setup/authkit/apply').set(INTERNAL).send({ keepPassword: false })
        expect(applied.status).toBe(200)
        expect(applied.body.restarting).toBe(false)
        expect(JSON.stringify(applied.body)).not.toContain(FAKE.WORKOS_COOKIE_PASSWORD)
        const saved = readSettingsFile(dir, KEY).values
        expect(saved.WORKOS_CLIENT_ID).toBe(FAKE.WORKOS_CLIENT_ID)
        expect(saved.CUTTLELY_BOOTSTRAP_EMAIL).toBe(FAKE.CUTTLELY_BOOTSTRAP_EMAIL)
        expect(saved.CUTTLELY_LOCAL_ADMIN).toBeUndefined()
        expect((await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })).status).toBe(
            410
        )
    })

    it('fails when someone else signs in, or the test comes back to another browser', async () => {
        const agent = await opened()
        exchangeUser = { ...exchangeUser, email: 'not-rosa@elsewhere.example' }
        let testState = new URL((await startTest(agent)).body.url).searchParams.get('state') as string
        await agent.get('/api/v1/auth/callback').query({ state: testState, code: 'made-up-code' })
        let status = await agent.get('/api/v1/server-setup/authkit/test')
        expect(status.body.status).toBe('failed')
        expect(status.body.message).toBe('AuthKit works, but this sign-in would not become the owner.')
        expect((await agent.post('/api/v1/server-setup/authkit/apply').set(INTERNAL).send({})).status).toBe(409)

        exchangeUser = { ...exchangeUser, email: 'rosa@rosas-bakery.example' }
        testState = new URL((await startTest(agent)).body.url).searchParams.get('state') as string
        const stranger = await request(server()).get('/api/v1/auth/callback').query({ state: testState, code: 'made-up-code' })
        expect(stranger.headers.location).toBe('/setup?authkit=done')
        status = await agent.get('/api/v1/server-setup/authkit/test')
        expect(status.body.status).toBe('failed')
        expect(readSettingsFile(dir, KEY).values.WORKOS_CLIENT_ID).toBeUndefined()
    })

    it('is closed to the owner path once an account exists mid-way', async () => {
        const agent = await opened()
        created.push({ email: 'someone@rosas-bakery.example', name: 'Someone', credential: null, externalId: null })
        const res = await startTest(agent)
        expect(res.status).toBe(410)
    })
})

describe('an expired setup code', () => {
    const base = Date.parse('2026-10-20T12:00:00.000Z')
    const later = base + SETUP_CODE_TTL_MS + 60_000

    async function issued(lines: string[]): Promise<string> {
        jest.spyOn(Date, 'now').mockReturnValue(base)
        resetFirstRunSetupCode()
        await announceFirstRunSetup(
            3000,
            async () => created.length,
            (line) => lines.push(line),
            false,
            env
        )
        await setupCodeReady()
        return firstRunSetupCode()
    }

    afterEach(() => {
        jest.restoreAllMocks()
        resetFirstRunSetupCode()
    })

    it('prints a new code from /open, and the new code opens a session', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        lines.length = 0
        const refused = await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code })
        expect(refused.status).toBe(404)
        expect(refused.body).toEqual({
            code: 'CODE_EXPIRED',
            reason: 'expired',
            message: 'This setup code has expired. A new code was printed in the server log.'
        })
        expect(JSON.stringify(refused.body)).not.toContain(code)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('A new setup link is ready'))
        expect(printed).toBeTruthy()
        const fresh = printed!.slice(printed!.indexOf('#code=') + '#code='.length)
        expect(JSON.stringify(refused.body)).not.toContain(fresh)
        expect(await setupCodeMatches(code)).toBe(false)
        expect(await setupCodeMatches(fresh)).toBe(true)
        expect((await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: fresh })).status).toBe(200)
    })

    it('refuses a code older than 60 minutes on /begin, prints a new one, and the new code is accepted', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        lines.length = 0
        const refused = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code })
        expect(refused.status).toBe(404)
        expect(refused.body).toEqual({
            code: 'CODE_EXPIRED',
            reason: 'expired',
            message: 'This setup code has expired. A new code was printed in the server log.'
        })
        expect(JSON.stringify(refused.body)).not.toContain(code)
        expect(await setupCodeMatches(code)).toBe(false)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('#code='))
        expect(printed).toBeTruthy()
        const fresh = printed!
            .slice(printed!.indexOf('#code=') + '#code='.length)
            .trim()
            .split(/\s/)[0]
        expect(fresh).not.toBe(code)
        expect(JSON.stringify(refused.body)).not.toContain(fresh)
        expect(await setupCodeMatches(fresh)).toBe(true)
        expect((await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: fresh })).status).toBe(200)
    })

    it('prints a new code from the owner call, and the new code opens a session', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        // Open while the code still has time, so the 30-minute session outlives the code.
        jest.spyOn(Date, 'now').mockReturnValue(base + 50 * 60 * 1000)
        const agent = request.agent(server())
        expect((await agent.post('/api/v1/server-setup/open').set(INTERNAL).send({ code })).status).toBe(200)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        lines.length = 0
        const res = await agent
            .post('/api/v1/server-setup/owner')
            .set(INTERNAL)
            .send({ name: 'Rosa', email: 'rosa@rosas-bakery.example', password: GOOD_PASSWORD })
        expect(res.status).toBe(410)
        await setupCodeReady()
        expect(created).toEqual([])
        const printed = lines.find((line) => line.includes('A new setup link is ready'))
        expect(printed).toBeTruthy()
        const fresh = printed!.slice(printed!.indexOf('#code=') + '#code='.length)
        expect(await setupCodeMatches(code)).toBe(false)
        expect((await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: fresh })).status).toBe(200)
    })

    it('leaves a live code in place when the submitted code is wrong', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        lines.length = 0
        const wrong = await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: 'wrong-code' })
        expect(wrong.status).toBe(404)
        expect(wrong.body).toEqual({ code: 'BAD_CODE', message: BAD_CODE })
        await setupCodeReady()
        expect(lines.some((line) => line.includes('A new setup link is ready'))).toBe(false)
        expect(await setupCodeMatches(code)).toBe(true)
    })

    function codeFrom(line: string): string {
        return line
            .slice(line.indexOf('#code=') + '#code='.length)
            .trim()
            .split(/\s/)[0]
    }

    /** The page starts the same check production does, and this test waits so /begin runs after the write. */
    function setupPage() {
        const app = server()
        app.get('/setup', async (_req, res) => {
            await reissueExpiredSetupIfOpen(async () => created.length, false, env)
            res.status(200).type('html').send('<!doctype html><title>setup</title>')
        })
        return app
    }

    it('says the old code expired after /setup prints a new one, and the new code works', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        lines.length = 0
        const app = setupPage()
        const page = await request(app).get('/setup')
        expect(page.status).toBe(200)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('A new setup link is ready'))
        expect(printed).toBeTruthy()
        const fresh = codeFrom(printed!)
        expect(fresh).not.toBe(code)
        const refused = await request(app).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code })
        expect(refused.status).toBe(404)
        expect(refused.body).toEqual({ code: 'CODE_EXPIRED', reason: 'expired', message: EXPIRED_CODE })
        expect(refused.body.message).toContain('expired')
        expect(refused.body.message).toContain('new code was printed')
        expect(JSON.stringify(refused.body)).not.toContain(code)
        expect(JSON.stringify(refused.body)).not.toContain(fresh)
        expect(await setupCodeMatches(code, later)).toBe(false)
        const again = await request(app).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code })
        expect(again.status).toBe(404)
        expect(again.body.code).toBe('CODE_EXPIRED')
        const unrelated = await request(app).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: 'not-the-code' })
        expect(unrelated.status).toBe(404)
        expect(unrelated.body).toEqual({ code: 'BAD_CODE', message: BAD_CODE })
        const opened = await request(app).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: fresh })
        expect(opened.status).toBe(200)
        expect(opened.body).toEqual({ next: 'choose' })
        const still = await request(app).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code })
        expect(still.status).toBe(404)
        expect(still.body).toEqual({ code: 'CODE_EXPIRED', reason: 'expired', message: EXPIRED_CODE })
        expect(await setupCodeMatches(code, later)).toBe(false)
        expect(await setupCodeMatches(fresh, later)).toBe(true)
    })

    it('says the old code expired after the one-minute check prints a new one', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        lines.length = 0
        await runSetupCodeWatch(later)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('A new setup link is ready'))
        expect(printed).toBeTruthy()
        const fresh = codeFrom(printed!)
        const refused = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code })
        expect(refused.status).toBe(404)
        expect(refused.body).toEqual({ code: 'CODE_EXPIRED', reason: 'expired', message: EXPIRED_CODE })
        expect(await setupCodeMatches(code, later)).toBe(false)
        expect((await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: fresh })).status).toBe(200)
        const still = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code })
        expect(still.body.code).toBe('CODE_EXPIRED')
        expect(await setupCodeMatches(fresh, later)).toBe(true)
    })

    it('gives /open the same expired answer after the code is replaced', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        lines.length = 0
        await reissueExpiredSetupCode(later)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('#code='))
        expect(printed).toBeTruthy()
        const fresh = codeFrom(printed!)
        const refused = await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code })
        expect(refused.status).toBe(404)
        expect(refused.body).toEqual({ code: 'CODE_EXPIRED', reason: 'expired', message: EXPIRED_CODE })
        expect(await setupCodeMatches(code, later)).toBe(false)
        expect((await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: fresh })).status).toBe(200)
        const still = await request(server()).post('/api/v1/server-setup/open').set(INTERNAL).send({ code })
        expect(still.body).toEqual({ code: 'CODE_EXPIRED', reason: 'expired', message: EXPIRED_CODE })
    })

    it('does not report a used code as expired', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        const hmac = issuedSetupHmac()
        expect(hmac).toBeTruthy()
        expect(await consumeSetupCode(hmac as string, base + 1000)).toBe(true)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        expect(await setupCodeVerdict(code, later)).toBe('rejected')
        const closed = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code })
        expect(closed.status).toBe(410)
        expect(closed.body.code).toBe('SETUP_CLOSED')
        expect(closed.body.code).not.toBe('CODE_EXPIRED')

        resetFirstRunSetupCode()
        const again = await issued(lines)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        lines.length = 0
        await reissueExpiredSetupCode(later)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('#code='))
        expect(printed).toBeTruthy()
        const fresh = codeFrom(printed!)
        const freshHmac = setupCodeHmac(fresh)
        expect(freshHmac).toBeTruthy()
        expect(await consumeSetupCode(freshHmac as string, later + 1000)).toBe(true)
        expect(await setupCodeVerdict(fresh, later + SETUP_CODE_TTL_MS)).toBe('rejected')
        expect(await setupCodeVerdict(again, later + SETUP_CODE_TTL_MS)).toBe('expired')
        const afterUse = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: fresh })
        expect(afterUse.status).toBe(410)
        expect(afterUse.body.code).not.toBe('CODE_EXPIRED')
        expect(await setupCodeMatches(again, later + SETUP_CODE_TTL_MS)).toBe(false)
        expect(await setupCodeMatches(fresh, later + SETUP_CODE_TTL_MS)).toBe(false)
    })

    it('counts an expired code toward the same address cap as a code that is not right', async () => {
        const lines: string[] = []
        const code = await issued(lines)
        jest.spyOn(Date, 'now').mockReturnValue(later)
        await reissueExpiredSetupCode(later)
        await setupCodeReady()
        resetSetupFailures()
        const app = server(true)
        for (let i = 0; i < 10; i++) {
            const res = await request(app)
                .post('/api/v1/server-setup/begin')
                .set(INTERNAL)
                .set('X-Forwarded-For', '203.0.113.9')
                .send({ code })
            expect(res.status).toBe(404)
            expect(res.body.code).toBe('CODE_EXPIRED')
        }
        const blocked = await request(app)
            .post('/api/v1/server-setup/begin')
            .set(INTERNAL)
            .set('X-Forwarded-For', '203.0.113.9')
            .send({ code })
        expect(blocked.status).toBe(429)
        expect(blocked.body.code).toBe('TOO_MANY')
        expect(await setupCodeMatches(code, later)).toBe(false)
    })
})

describe('begin and hint limits', () => {
    it('counts failures by socket address, still accepts the right code, and sends setup headers', async () => {
        const code = firstRunSetupCode()
        await setupCodeReady()
        for (const trust of [true, 1] as const) {
            resetSetupFailures()
            const app = server(trust)
            for (let i = 0; i < 5; i++) {
                const hint = await request(app).get('/api/v1/server-setup/hint').set('X-Forwarded-For', `203.0.113.${i}`)
                expect(hint.status).toBe(200)
                expectSetupHeaders(hint.headers)
            }
            expect(setupFailureLimited('127.0.0.1', Date.now())).toBe(false)
            for (let i = 0; i < 10; i++) {
                const res = await request(app)
                    .post('/api/v1/server-setup/begin')
                    .set(INTERNAL)
                    .set('X-Forwarded-For', `198.51.100.${i}`)
                    .send({ code: 'not-the-code' })
                expect(res.status).toBe(404)
                expect(res.body).toEqual({ code: 'BAD_CODE', message: BAD_CODE })
                expectSetupHeaders(res.headers)
            }
            expect(setupFailureLimited('127.0.0.1', Date.now())).toBe(true)
            const blocked = await request(app)
                .post('/api/v1/server-setup/begin')
                .set(INTERNAL)
                .set('X-Forwarded-For', '203.0.113.77')
                .send({ code: 'not-the-code' })
            expect(blocked.status).toBe(429)
            expectSetupHeaders(blocked.headers)
            const hintBlocked = await request(app).get('/api/v1/server-setup/hint').set('X-Forwarded-For', '203.0.113.88')
            expect(hintBlocked.status).toBe(429)
            expect(hintBlocked.body.code).toBe('TOO_MANY')
            expectSetupHeaders(hintBlocked.headers)
            const allowed = await request(app)
                .post('/api/v1/server-setup/begin')
                .set(INTERNAL)
                .set('X-Forwarded-For', '192.0.2.8')
                .send({ code })
            expect(allowed.status).toBe(200)
            expect(allowed.body).toEqual({ next: 'choose' })
            expectSetupHeaders(allowed.headers)
        }
    })

    it('records begin failures toward the server-wide cap once, and the new code still opens setup', async () => {
        const lines: string[] = []
        await announceFirstRunSetup(
            3000,
            async () => created.length,
            (line) => lines.push(line),
            false,
            env
        )
        await setupCodeReady()
        const code = firstRunSetupCode()
        lines.length = 0
        const now = Date.now()
        for (let i = 0; i < 99; i++) noteSetupFailure(`192.0.2.${i % 20}`, now)
        const app = server(true)
        const hit = await request(app)
            .post('/api/v1/server-setup/begin')
            .set(INTERNAL)
            .set('X-Forwarded-For', '198.51.100.8')
            .send({ code: 'not-the-code' })
        expect(hit.status).toBe(404)
        await setupCodeReady()
        const printed = lines.filter((line) => line.includes('A new setup link is ready'))
        expect(printed).toHaveLength(1)
        const fresh = printed[0].slice(printed[0].indexOf('#code=') + '#code='.length)
        expect(fresh).not.toBe(code)
        expect(await setupCodeMatches(code)).toBe(false)
        expect(await setupCodeVerdict(code)).toBe('rejected')
        expect(await setupCodeMatches(fresh)).toBe(true)
        const again = await request(app)
            .post('/api/v1/server-setup/begin')
            .set(INTERNAL)
            .set('X-Forwarded-For', '198.51.100.9')
            .send({ code: 'still-wrong' })
        expect(again.status).toBe(429)
        await setupCodeReady()
        expect(lines.filter((line) => line.includes('A new setup link is ready'))).toHaveLength(1)
        for (let i = 0; i < 20; i++) noteSetupFailure(`198.51.100.${i}`, now)
        await setupCodeReady()
        expect(lines.filter((line) => line.includes('A new setup link is ready'))).toHaveLength(1)
        const hint = await request(app).get('/api/v1/server-setup/hint')
        expect(hint.status).toBe(429)
        expectSetupHeaders(hint.headers)
        const opened = await request(app).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: fresh })
        expect(opened.status).toBe(200)
        expect(opened.body).toEqual({ next: 'choose' })
    })
})

describe('the setup session cookie and the setup page', () => {
    const sessionRoutes = [
        '/api/v1/server-setup/state',
        '/api/v1/server-setup/owner',
        '/api/v1/server-setup/authkit/check',
        '/api/v1/server-setup/authkit/test',
        '/api/v1/server-setup/authkit/apply'
    ]

    it('sets the narrowed cookie paths and the session routes sit under them', async () => {
        expect([...SETUP_COOKIE_PATHS].sort()).toEqual(['/api/v1/auth/callback', '/api/v1/server-setup'])
        const begun = await request(server()).post('/api/v1/server-setup/begin').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(begun.status).toBe(200)
        const paths = cookiePathList(begun.headers['set-cookie']).sort()
        expect(paths).toEqual([...SETUP_COOKIE_PATHS].sort())
        for (const route of sessionRoutes) {
            expect(paths.some((cookiePath) => requestPathMatchesCookie(cookiePath, route))).toBe(true)
        }
        expect(paths.some((cookiePath) => requestPathMatchesCookie(cookiePath, '/api/v1/account/register'))).toBe(false)
        expect(paths.some((cookiePath) => requestPathMatchesCookie(cookiePath, '/api/v1/auth/callback'))).toBe(true)

        const forState = browserCookie(begun.headers['set-cookie'], '/api/v1/server-setup/state')
        expect(forState).toContain('cuttlely-setup=')
        const state = await request(server()).get('/api/v1/server-setup/state').set('Cookie', forState).set(INTERNAL)
        expect(state.status).toBe(200)
        expect(browserCookie(begun.headers['set-cookie'], '/api/v1/account/register')).toBe('')
        expect(browserCookie(begun.headers['set-cookie'], '/api/v1/auth/callback')).toContain('cuttlely-setup=')
        const forCallback = browserCookie(begun.headers['set-cookie'], '/api/v1/server-setup/authkit/test')
        const status = await request(server()).get('/api/v1/server-setup/authkit/test').set('Cookie', forCallback)
        expect(status.status).not.toBe(401)
    })
})

describe('the five minute setup reminder', () => {
    const base = Date.parse('2026-10-20T12:00:00.000Z')

    afterEach(() => {
        jest.useRealTimers()
        resetFirstRunSetupCode()
    })

    it('reprints the live code, skips an expired one, and does not issue another', async () => {
        jest.useFakeTimers()
        jest.setSystemTime(base)
        resetFirstRunSetupCode()
        const lines: string[] = []
        const log = (line: string) => lines.push(line)
        await announceFirstRunSetup(3000, async () => 0, log, true, env)
        await setupCodeReady()
        const code = firstRunSetupCode()
        let stop: () => void = () => undefined
        try {
            stop = watchFirstRunSetup(3000, async () => 0, log, true, env, 1000)
            lines.length = 0
            await jest.advanceTimersByTimeAsync(1000)
            const reprinted = lines.join('\n')
            expect(reprinted).toContain(`Setup code: ${code}`)
            expect(reprinted).not.toContain('A new setup link is ready')
            expect(firstRunSetupCode()).toBe(code)

            const hmac = issuedSetupHmac()
            lines.length = 0
            jest.setSystemTime(base + SETUP_CODE_TTL_MS + 60_000)
            await jest.advanceTimersByTimeAsync(1000)
            expect(lines.join('\n')).not.toContain(`Setup code: ${code}`)
            expect(lines.some((line) => line.includes('A new setup link is ready'))).toBe(false)
            expect(issuedSetupHmac()).toBe(hmac)

            lines.length = 0
            await reissueExpiredSetupCode(base + SETUP_CODE_TTL_MS + 60_000)
            await setupCodeReady()
            const fresh = firstRunSetupCode()
            expect(fresh).not.toBe(code)
            const freshHmac = issuedSetupHmac()
            lines.length = 0
            await jest.advanceTimersByTimeAsync(1000)
            const again = lines.join('\n')
            expect(again).toContain(`Setup code: ${fresh}`)
            expect(again).not.toContain(`Setup code: ${code}`)
            expect(again).not.toContain('A new setup link is ready')
            expect(issuedSetupHmac()).toBe(freshHmac)
            expect(firstRunSetupCode()).toBe(fresh)
        } finally {
            stop()
        }
    })
})
