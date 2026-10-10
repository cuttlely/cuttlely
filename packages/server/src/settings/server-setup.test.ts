import cookieParser from 'cookie-parser'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { announceFirstRunSetup, firstRunSetupCode, resetFirstRunSetupCode, serverSetupLink } from '../identity/setupCode'
import { CreateOwnerInput, UserRow } from '../identity/types'
import { StartState } from './apply'
import { AuthKitDeps, AuthKitPort, resetAuthKitTests } from './authkit'
import { readHistory } from './history'
import { endSetupSessions } from './setup-session'
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

let data: string
let dir: string
let env: Record<string, string | undefined>
let state: StartState
let now: number
let created: CreateOwnerInput[]
let exchangeUser: { id: string; email: string; emailVerified: boolean; name: string | null }

function users() {
    return {
        countUsers: async () => created.length,
        createOwner: async (input: CreateOwnerInput) => {
            created.push(input)
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

function server() {
    const app = express()
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
        expect(await announceFirstRunSetup(3000, async () => 0, log, false, env)).toBe(true)
        expect(lines).toEqual([expect.stringContaining('https://rosas-bakery.example/server-setup?code=')])
        expect(lines[0]).toContain(serverSetupLink(3000, env))
        expect(lines[0]).toContain('The link works once.')
        lines.length = 0
        // Accounts exist but nobody can sign in: no link (it would create nothing), only how to turn a method back on.
        expect(await announceFirstRunSetup(3000, async () => 1, log, false, env)).toBe(true)
        expect(lines).toEqual([expect.stringContaining('nobody can sign in')])
        expect(lines[0]).not.toContain('code=')
        lines.length = 0
        const authKitOn = { ...env, ...FAKE }
        expect(await announceFirstRunSetup(3000, async () => 0, log, false, authKitOn)).toBe(false)
        expect(lines).toEqual([])
    })

    it('falls back to APP_URL, then this machine', () => {
        expect(serverSetupLink(3000, { APP_URL: 'https://flows.rosas-bakery.example/x' })).toMatch(
            /^https:\/\/flows\.rosas-bakery\.example\/server-setup\?code=/
        )
        expect(serverSetupLink(3000, { APP_URL: 'not an address' })).toMatch(/^http:\/\/localhost:3000\/server-setup\?code=/)
    })
})

describe('opening the link', () => {
    it('needs the right code and the app header, then sets a strict cookie', async () => {
        const app = server()
        expect((await request(app).post('/api/v1/server-setup/open').send({ code: firstRunSetupCode() })).status).toBe(401)
        expect((await request(app).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: 'wrong' })).status).toBe(404)
        expect((await request(app).get('/api/v1/server-setup/state')).status).toBe(401)
        const res = await request(app).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(res.status).toBe(200)
        const cookie = String(res.headers['set-cookie'])
        expect(cookie).toMatch(/cuttlely-setup=/)
        expect(cookie).toMatch(/HttpOnly/)
        expect(cookie).toMatch(/SameSite=Strict/)
        expect(cookie).not.toContain(firstRunSetupCode())
    })

    it('is closed once an account exists or a sign-in method is on', async () => {
        const app = server()
        created.push({ email: 'someone@rosas-bakery.example', name: 'Someone', credential: null, externalId: null })
        const res = await request(app).post('/api/v1/server-setup/open').set(INTERNAL).send({ code: firstRunSetupCode() })
        expect(res.status).toBe(410)
        expect(res.body.message).toBe('This server already has an account. Sign in instead.')
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
        expect(back.headers.location).toBe('/server-setup?authkit=done')
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
        expect(stranger.headers.location).toBe('/server-setup?authkit=done')
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
