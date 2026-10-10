import express, { Request } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { setTeamPermissionLookup } from '../identity/rbac'
import { UserRow } from '../identity/types'
import { StartState } from './apply'
import { AuthKitDeps, AuthKitPort, TEST_STATE_PREFIX, checkAuthKitValues, resetAuthKitTests } from './authkit'
import { AUTHKIT_PROOF_FILE, authKitFingerprint, authKitTested } from './authkit-proof'
import { readHistory } from './history'
import { SETTINGS_FILE, readSettingsFile, writeSettingsFile } from './store'

jest.mock('./bootstrap', () => ({
    startState: { dir: '', hostKeys: [], atStart: {}, applied: [], unreadable: [], problems: [] }
}))

import router, { authKitTestCallback, isAuthKitTestCallback, setAuthKitDeps, setServerSettingsDeps } from '../routes/server-settings/index'

// Obviously fake values only. No real WorkOS account is used anywhere in these tests.
const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const FAKE = {
    WORKOS_API_KEY: 'sk_test_obviously_fake_0000',
    WORKOS_CLIENT_ID: 'client_obviously_fake_0000',
    WORKOS_REDIRECT_URI: 'http://127.0.0.1/api/v1/auth/callback',
    WORKOS_COOKIE_PASSWORD: 'obviously-fake-seal-0000000000000000000000'
}
const OWNER = { id: 'owner-1', email: 'owner@rosas-bakery.example', activeWorkspaceId: 'team-a', permissions: [] }
const OWNER_ROW: UserRow = {
    id: 'owner-1',
    email: 'owner@rosas-bakery.example',
    name: 'Rosa',
    status: 'active',
    externalId: null
} as unknown as UserRow
const SESSION = 'made-up-session-token-1'

let data: string
let dir: string
let env: Record<string, string | undefined>
let state: StartState
let now: number
let exchanged: { code: string; apiKey: string; cookiePassword: string }[]
let exchangeUser: { id: string; email: string; emailVerified: boolean; name: string | null }
let exchangeError: unknown
let rows: UserRow[]
let keyAnswer: 'ok' | 'rejected' | 'unreachable'

function fakeKit(): AuthKitDeps {
    const port: AuthKitPort = {
        authorizationUrl: ({ clientId, redirectUri, state: s }) =>
            `https://authkit.example/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${s}`,
        exchange: async ({ code, apiKey, cookiePassword }) => {
            exchanged.push({ code, apiKey, cookiePassword })
            if (exchangeError) throw exchangeError
            return { user: exchangeUser, sealed: `sealed:${cookiePassword}` }
        },
        unseal: async ({ sealed, cookiePassword }) => sealed === `sealed:${cookiePassword}`,
        checkKey: async () => keyAnswer
    }
    return {
        port,
        users: () => ({
            findUserByExternalId: async (id) => rows.find((row) => row.externalId === id) ?? null,
            findUsersByEmail: async (email) => rows.filter((row) => row.email.toLowerCase() === email.toLowerCase())
        }),
        now: () => now
    }
}

function app(user: object | null = OWNER, session: string | null = SESSION) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        ;(req as Request).cookies = session ? { 'cuttlely-local-session': session } : {}
        next()
    })
    server.use('/api/v1/server-settings', router)
    server.get('/api/v1/auth/callback', (req, res, next) => {
        if (isAuthKitTestCallback(req)) return void authKitTestCallback(req, res, next)
        res.status(418).send('normal sign-in')
    })
    return request(server)
}

async function startTest(values: Record<string, string> = FAKE) {
    const res = await app().post('/api/v1/server-settings/authkit/test').send({ values })
    expect(res.status).toBe(200)
    return new URL(res.body.url).searchParams.get('state') as string
}

beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-authkit-'))
    dir = path.join(data, 'settings')
    env = { CUTTLELY_DATA_DIR: data, CUTTLELY_LOCAL_ADMIN: 'true' }
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
    now = Date.parse('2026-10-09T12:00:00Z')
    exchanged = []
    exchangeUser = { id: 'user_fake_1', email: 'owner@rosas-bakery.example', emailVerified: true, name: 'Rosa' }
    exchangeError = null
    rows = [{ ...OWNER_ROW }]
    keyAnswer = 'rejected'
    resetAuthKitTests()
    writeSettingsFile(dir, { CUTTLELY_LOCAL_ADMIN: 'true' }, { key: KEY, by: 'owner' })
    setServerSettingsDeps(() => ({ env, state, key: async () => KEY }))
    setAuthKitDeps(fakeKit)
    setTeamPermissionLookup({ accessFor: async (userId) => ({ owner: userId === 'owner-1', permissions: [] }) })
})

afterEach(() => setTeamPermissionLookup(null))

describe('checking the values', () => {
    it('detects Staging and Production and explains each field', () => {
        expect(checkAuthKitValues(FAKE, 'http://127.0.0.1').environment).toBe('staging')
        const live = checkAuthKitValues({ ...FAKE, WORKOS_API_KEY: 'sk_live_obviously_fake_0000' }, 'http://127.0.0.1')
        expect(live.environment).toBe('production')
        expect(live.ok).toBe(false)
        expect(live.checks.find((check) => check.key === 'WORKOS_REDIRECT_URI')?.detail).toBe('Production needs an https:// address.')
        const bad = checkAuthKitValues(
            {
                WORKOS_API_KEY: 'nope',
                WORKOS_CLIENT_ID: 'abc',
                WORKOS_REDIRECT_URI: 'http://127.0.0.1/callback',
                WORKOS_COOKIE_PASSWORD: 'short'
            },
            'http://127.0.0.1'
        )
        expect(bad.checks.filter((check) => !check.ok).map((check) => check.key)).toEqual([
            'WORKOS_API_KEY',
            'WORKOS_CLIENT_ID',
            'WORKOS_REDIRECT_URI',
            'WORKOS_COOKIE_PASSWORD'
        ])
    })

    it('warns when the browser is on a different address than the redirect', () => {
        const result = checkAuthKitValues(FAKE, 'http://localhost:3000')
        const redirect = result.checks.find((check) => check.key === 'WORKOS_REDIRECT_URI')
        expect(redirect).toMatchObject({ ok: true, warn: true })
        expect(result.addresses).toEqual({
            redirectUri: 'http://127.0.0.1/api/v1/auth/callback',
            signOutUri: 'http://127.0.0.1/signin',
            homepage: 'http://127.0.0.1',
            initiateLogin: 'http://127.0.0.1/api/v1/auth/login'
        })
    })

    it('says plainly when WorkOS refuses a fake key, and never echoes it', async () => {
        const res = await app().post('/api/v1/server-settings/authkit/check').send({ values: FAKE })
        expect(res.status).toBe(200)
        expect(res.body.ok).toBe(false)
        expect(res.body.checks[0]).toMatchObject({ key: 'WORKOS_API_KEY', ok: false, detail: 'WorkOS did not accept this API key.' })
        expect(JSON.stringify(res.body)).not.toContain(FAKE.WORKOS_API_KEY)
        expect(JSON.stringify(res.body)).not.toContain(FAKE.WORKOS_COOKIE_PASSWORD)
        keyAnswer = 'unreachable'
        const offline = await app().post('/api/v1/server-settings/authkit/check').send({ values: FAKE })
        expect(offline.body.checks[0]).toMatchObject({ ok: true, warn: true })
    })

    it('is owner only', async () => {
        const member = { ...OWNER, id: 'member-1' }
        expect((await app(member).post('/api/v1/server-settings/authkit/check').send({ values: FAKE })).status).toBe(403)
        expect((await app(member).post('/api/v1/server-settings/authkit/test').send({ values: FAKE })).status).toBe(403)
        expect((await app(null).get('/api/v1/server-settings/authkit/test')).status).toBe(401)
    })
})

describe('test sign-in', () => {
    it('refuses to start with values that fail the checks', async () => {
        const res = await app()
            .post('/api/v1/server-settings/authkit/test')
            .send({ values: { ...FAKE, WORKOS_CLIENT_ID: 'nope' } })
        expect(res.status).toBe(400)
        expect(res.body.errors[0].key).toBe('WORKOS_CLIENT_ID')
    })

    it('passes, records a proof without the values, and saves only when asked', async () => {
        const testState = await startTest()
        expect(testState.startsWith('dfst.')).toBe(true)
        expect((await app().get('/api/v1/server-settings/authkit/test')).body.status).toBe('waiting')
        const back = await app().get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        expect(back.status).toBe(302)
        expect(back.headers.location).toBe('/server-settings?section=signin&authkit=done')
        expect(exchanged).toEqual([{ code: 'fake-code', apiKey: FAKE.WORKOS_API_KEY, cookiePassword: FAKE.WORKOS_COOKIE_PASSWORD }])
        const status = (await app().get('/api/v1/server-settings/authkit/test')).body
        expect(status).toMatchObject({ status: 'passed', signedInAs: 'owner@rosas-bakery.example', environment: 'staging' })
        expect(status.values.WORKOS_API_KEY).toEqual({ set: true })
        expect(JSON.stringify(status)).not.toContain(FAKE.WORKOS_API_KEY)
        const proof = fs.readFileSync(path.join(dir, AUTHKIT_PROOF_FILE), 'utf8')
        expect(proof).not.toContain(FAKE.WORKOS_API_KEY)
        expect(proof).toContain(authKitFingerprint(FAKE, KEY))
        // Nothing saved yet.
        expect(readSettingsFile(dir, KEY).values.WORKOS_API_KEY).toBeUndefined()
        const applied = await app().post('/api/v1/server-settings/authkit/apply').send({ keepPassword: false })
        expect(applied.status).toBe(200)
        const saved = readSettingsFile(dir, KEY).values
        expect(saved).toMatchObject({ ...FAKE, CUTTLELY_LOCAL_ADMIN: 'false' })
        expect(applied.body.authKit).toMatchObject({ complete: true, environment: 'staging', tested: true })
        expect(readHistory(dir, 10).map((entry) => entry.kind)).toEqual(['save', 'test'])
        expect((await app().post('/api/v1/server-settings/authkit/apply').send({})).status).toBe(409)
    })

    it('keeps password sign-in on by default', async () => {
        const testState = await startTest()
        await app().get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        await app().post('/api/v1/server-settings/authkit/apply').send({})
        expect(readSettingsFile(dir, KEY).values.CUTTLELY_LOCAL_ADMIN).toBe('true')
    })

    it('must come back to the same browser session', async () => {
        const testState = await startTest()
        await app(null, 'another-session').get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        const status = (await app().get('/api/v1/server-settings/authkit/test')).body
        expect(status.status).toBe('failed')
        expect(exchanged).toHaveLength(0)
        expect(fs.existsSync(path.join(dir, AUTHKIT_PROOF_FILE))).toBe(false)
    })

    it('fails when AuthKit signs in somebody who is not the owner', async () => {
        exchangeUser = { id: 'user_fake_2', email: 'baker@rosas-bakery.example', emailVerified: true, name: null }
        const testState = await startTest()
        await app().get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        const status = (await app().get('/api/v1/server-settings/authkit/test')).body
        expect(status.status).toBe('failed')
        expect(status.steps.at(-1)).toMatchObject({ label: 'Signs in as you', ok: false })
        expect((await app().post('/api/v1/server-settings/authkit/apply').send({})).status).toBe(409)
    })

    it('explains a link to the other WorkOS environment', async () => {
        rows = [{ ...OWNER_ROW, externalId: 'user_from_staging' } as UserRow]
        const testState = await startTest()
        await app().get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        const status = (await app().get('/api/v1/server-settings/authkit/test')).body
        expect(status.steps.at(-1).detail).toMatch(/other WorkOS environment/)
    })

    it('reports WorkOS errors and an expired test', async () => {
        exchangeError = Object.assign(new Error(`bad ${FAKE.WORKOS_API_KEY}`), { status: 401 })
        let testState = await startTest()
        await app().get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        let status = (await app().get('/api/v1/server-settings/authkit/test')).body
        expect(status.status).toBe('failed')
        expect(JSON.stringify(status)).not.toContain(FAKE.WORKOS_API_KEY)
        testState = await startTest()
        now += 11 * 60 * 1000
        const back = await app().get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        expect(back.headers.location).toContain('authkit=expired')
        status = (await app().get('/api/v1/server-settings/authkit/test')).body
        expect(status.status).toBe('expired')
        const unknown = await app().get('/api/v1/auth/callback?code=x&state=dfst.not-a-test')
        expect(unknown.headers.location).toContain('authkit=expired')
    })

    it('is recognized by the real callback route', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'identity', 'http.ts'), 'utf8')
        expect(source).toContain(`startsWith('${TEST_STATE_PREFIX}')`)
    })

    it('leaves normal sign-ins alone', async () => {
        expect((await app().get('/api/v1/auth/callback?code=x&state=something-else')).status).toBe(418)
        expect((await app().get('/api/v1/auth/callback?code=x')).status).toBe(418)
    })
})

describe('password sign-in stays on until a test passes', () => {
    it('refuses to turn password sign-in off with untested AuthKit values', async () => {
        writeSettingsFile(dir, { CUTTLELY_LOCAL_ADMIN: 'true', ...FAKE }, { key: KEY, by: 'owner' })
        const res = await app()
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_LOCAL_ADMIN: 'false' } })
        expect(res.status).toBe(409)
        expect(res.body.code).toBe('AUTHKIT_NOT_TESTED')
    })

    it('allows it once these exact values passed, and asks again when they change', async () => {
        writeSettingsFile(dir, { CUTTLELY_LOCAL_ADMIN: 'true', ...FAKE }, { key: KEY, by: 'owner' })
        const testState = await startTest({})
        await app().get(`/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(testState)}`)
        expect(authKitTested(dir, FAKE, KEY)).toBe(true)
        expect(
            (
                await app()
                    .put('/api/v1/server-settings')
                    .send({ values: { CUTTLELY_LOCAL_ADMIN: 'false' } })
            ).status
        ).toBe(200)
        const changed = await app()
            .put('/api/v1/server-settings')
            .send({ values: { WORKOS_CLIENT_ID: 'client_obviously_fake_0001' } })
        expect(changed.status).toBe(409)
        expect(changed.body.code).toBe('AUTHKIT_NOT_TESTED')
        expect(
            (
                await app()
                    .put('/api/v1/server-settings')
                    .send({ values: { LOG_LEVEL: 'debug' } })
            ).status
        ).toBe(200)
    })

    it('does not get in the way when the host turned password sign-in off already', async () => {
        fs.rmSync(path.join(dir, SETTINGS_FILE))
        env = { CUTTLELY_DATA_DIR: data, CUTTLELY_LOCAL_ADMIN: 'false', ...FAKE }
        state.hostKeys = ['CUTTLELY_LOCAL_ADMIN', ...Object.keys(FAKE)]
        expect(
            (
                await app()
                    .put('/api/v1/server-settings')
                    .send({ values: { LOG_LEVEL: 'debug' } })
            ).status
        ).toBe(200)
    })
})
