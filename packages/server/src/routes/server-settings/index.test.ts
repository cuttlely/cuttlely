import express, { Request } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../../identity/apiGate'
import { setTeamPermissionLookup } from '../../identity/rbac'
import { isServerSettingsUrl } from '../../settings/redact'
import { StartState } from '../../settings/apply'
import { readHistory } from '../../settings/history'
import { resetRestartRequest, setRestartHandler } from '../../settings/restart'
import { resetRuns } from '../../settings/runs'
import { publishCheckEnabled, resetRuntimeLimitsForTests, runtimeNumber } from '../../settings/runtime'
import { SETTINGS_FILE, readSettingsFile, readStoredValues, writeSettingsFile } from '../../settings/store'

jest.mock('../../settings/bootstrap', () => ({
    startState: { dir: '', hostKeys: [], atStart: {}, applied: [], unreadable: [], problems: [] }
}))

import router, { setServerSettingsDeps } from './index'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const SECRET = 'pw-made-up-for-the-bakery-0001'
const OWNER = { id: 'owner-1', email: 'owner@example.com', activeWorkspaceId: 'team-a', permissions: [] }
const MEMBER = { id: 'member-1', email: 'baker@example.com', activeWorkspaceId: 'team-a', permissions: ['server:owner'] }
const API_KEY = { permissions: ['*'], activeWorkspaceId: 'team-a' }
const WORKSPACE_ADMIN = {
    id: 'ws-admin',
    email: 'lead@example.com',
    activeWorkspaceId: 'team-a',
    isOrganizationAdmin: true,
    permissions: ['chatflows:view', 'agentflows:update', 'users:manage']
}

let dir: string
let env: Record<string, string | undefined>
let state: StartState

function app(user: object | null) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        next()
    })
    server.use('/api/v1/server-settings', router)
    return request(server)
}

function gated(
    overrides: {
        attachIdentitySession?: (req: Request) => Promise<object | null>
        validateAPIKey?: () => Promise<{ isValid: boolean; apiKey?: { workspaceId?: string; permissions: string[] } }>
    } = {}
) {
    const server = express()
    server.use(express.json())
    server.use(
        apiV1Auth({
            whitelistURLs: ['/api/v1/ping'],
            apiKeyBlacklistURLs: ['/api/v1/server-settings'],
            licenseRequired: () => false,
            dataSource: { getRepository: () => ({ findOne: async () => null }) } as unknown as DataSource,
            validateAPIKey: overrides.validateAPIKey ?? (async () => ({ isValid: false })),
            attachIdentitySession: overrides.attachIdentitySession ?? (async () => null)
        })
    )
    server.use('/api/v1/server-settings', router)
    return request(server)
}

beforeEach(() => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-api-'))
    dir = path.join(data, 'settings')
    env = { CUTTLELY_DATA_DIR: data, CUTTLELY_LOCAL_ADMIN: 'true', LOG_LEVEL: 'warn' }
    state = {
        dir,
        ignored: false,
        byStartScript: false,
        hostKeys: ['CUTTLELY_LOCAL_ADMIN', 'LOG_LEVEL'],
        atStart: {},
        applied: [],
        unreadable: [],
        problems: [],
        rawAtStart: null
    }
    setServerSettingsDeps(() => ({ env, state, key: async () => KEY }))
    setTeamPermissionLookup({ accessFor: async (userId) => ({ owner: userId === 'owner-1', permissions: [] }) })
})

afterEach(() => {
    setTeamPermissionLookup(null)
    setRestartHandler(null)
    resetRestartRequest()
    resetRuns()
    resetRuntimeLimitsForTests()
})

describe('who can use server settings', () => {
    it('lets the owner in and keeps everyone else out, including API keys', async () => {
        expect((await app(OWNER).get('/api/v1/server-settings')).status).toBe(200)
        expect((await app(MEMBER).get('/api/v1/server-settings')).status).toBe(403)
        expect((await app(WORKSPACE_ADMIN).get('/api/v1/server-settings')).status).toBe(403)
        expect((await app(API_KEY).get('/api/v1/server-settings')).status).toBe(403)
        expect((await app(null).get('/api/v1/server-settings')).status).toBe(401)
        expect(
            (
                await app(API_KEY)
                    .put('/api/v1/server-settings')
                    .send({ values: { CUTTLELY_CHECK_CONCURRENCY: '3' } })
            ).status
        ).toBe(403)
        expect(
            (
                await app(WORKSPACE_ADMIN)
                    .put('/api/v1/server-settings')
                    .send({ values: { CUTTLELY_CHECK_CONCURRENCY: '3' } })
            ).status
        ).toBe(403)
        expect(
            (
                await app(null)
                    .put('/api/v1/server-settings')
                    .send({ values: { CUTTLELY_CHECK_CONCURRENCY: '3' } })
            ).status
        ).toBe(401)
        expect(
            (
                await app(MEMBER)
                    .put('/api/v1/server-settings')
                    .send({ values: { CUTTLELY_ANALYST: 'auto' } })
            ).status
        ).toBe(403)
        expect((await app(MEMBER).post('/api/v1/server-settings/restart')).status).toBe(403)
        expect((await app(MEMBER).get('/api/v1/server-settings/history')).status).toBe(403)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('returns 401 from the API gate for a missing session and an API key, and 403 for a signed-in non-owner', async () => {
        const validateAPIKey = jest.fn(async () => ({
            isValid: true,
            apiKey: { workspaceId: 'team-a', permissions: ['*'] }
        }))
        const missing = await gated().get('/api/v1/server-settings')
        const keyed = await gated({ validateAPIKey }).get('/api/v1/server-settings').set('Authorization', 'Bearer good-key')
        const keyedWrite = await gated({ validateAPIKey })
            .put('/api/v1/server-settings')
            .set('Authorization', 'Bearer good-key')
            .send({ values: { CUTTLELY_CHECK_CONCURRENCY: '3' } })
        expect(missing.status).toBe(401)
        expect(missing.body).toEqual({ error: 'Unauthorized Access' })
        expect(keyed.status).toBe(401)
        expect(keyed.body).toEqual({ error: 'Unauthorized Access' })
        expect(keyedWrite.status).toBe(401)
        expect(validateAPIKey).not.toHaveBeenCalled()
        const member = await gated({ attachIdentitySession: async () => MEMBER }).get('/api/v1/server-settings')
        const memberWrite = await gated({ attachIdentitySession: async () => MEMBER })
            .put('/api/v1/server-settings')
            .set('x-request-from', 'internal')
            .send({ values: { CUTTLELY_CHECK_CONCURRENCY: '3' } })
        expect(member.status).toBe(403)
        expect(member.body).toEqual({ message: 'Forbidden' })
        expect(memberWrite.status).toBe(403)
        const owner = await gated({ attachIdentitySession: async () => OWNER }).get('/api/v1/server-settings')
        expect(owner.status).toBe(200)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('keeps request bodies for this API out of debug logs', () => {
        expect(isServerSettingsUrl('/api/v1/server-settings')).toBe(true)
        expect(isServerSettingsUrl('/api/v1/server-settings/discard')).toBe(true)
        expect(isServerSettingsUrl('/api/v1/settings')).toBe(false)
    })
})

describe('reading settings', () => {
    it('shows host values as locked and never returns a secret', async () => {
        writeSettingsFile(dir, { CUTTLELY_ANALYST: 'auto', WORKOS_API_KEY: SECRET }, { key: KEY })
        const res = await app(OWNER).get('/api/v1/server-settings')
        expect(JSON.stringify(res.body)).not.toContain(SECRET)
        expect(res.headers['cache-control']).toBe('no-store')
        const byKey = new Map(res.body.settings.map((s: { key: string }) => [s.key, s]))
        expect(byKey.get('LOG_LEVEL')).toMatchObject({ locked: true, source: 'host', value: 'warn' })
        expect(byKey.get('WORKOS_API_KEY')).toMatchObject({ source: 'file', secret: { set: true, unreadable: false }, changed: true })
        expect(byKey.get('WORKOS_API_KEY')).not.toHaveProperty('value')
        expect(byKey.get('CUTTLELY_ANALYST')).toMatchObject({ value: 'auto', running: '', changed: true })
        expect(res.body.restart).toMatchObject({ inPlace: false, install: 'source' })
        expect(res.body.restart.changed).toEqual(['CUTTLELY_ANALYST', 'WORKOS_API_KEY'])
        expect(res.body.keptOut.length).toBeGreaterThan(3)
    })
})

describe('saving settings', () => {
    it('saves, encrypts secrets, records history without values, and answers with the new view', async () => {
        const res = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({
                values: { CUTTLELY_ANALYST: 'auto', WORKOS_API_KEY: SECRET, CORS_ORIGINS: ' https://a.example.com ,https://b.example.com,' }
            })
        expect(res.status).toBe(200)
        expect(JSON.stringify(res.body)).not.toContain(SECRET)
        expect(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).not.toContain(SECRET)
        expect(readSettingsFile(dir, KEY).values).toEqual({
            CORS_ORIGINS: 'https://a.example.com,https://b.example.com',
            CUTTLELY_ANALYST: 'auto',
            WORKOS_API_KEY: SECRET
        })
        const [entry] = readHistory(dir)
        expect(entry).toMatchObject({ kind: 'save', by: 'owner@example.com' })
        expect(entry.changes).toContainEqual({ key: 'WORKOS_API_KEY', secret: 'changed' })
        expect(JSON.stringify(entry)).not.toContain(SECRET)
        const removed = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { WORKOS_API_KEY: '' } })
        expect(removed.status).toBe(200)
        expect(readHistory(dir)[0].changes).toEqual([{ key: 'WORKOS_API_KEY', secret: 'changed' }])
    })

    it('refuses host-set, unknown, kept-out, invalid and database values, and saves nothing', async () => {
        const res = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({
                values: {
                    LOG_LEVEL: 'debug',
                    NOPE: 'x',
                    CUSTOM_MCP_ALLOWED_COMMANDS: 'bash',
                    CUTTLELY_HARNESS_TURN_BUDGET_MS: 'soon',
                    DATABASE_TYPE: 'postgres',
                    CUTTLELY_ANALYST: 'auto'
                }
            })
        expect(res.status).toBe(400)
        expect(res.body.code).toBe('INVALID')
        expect(res.body.errors.map((error: { key: string }) => error.key).sort()).toEqual(
            ['CUSTOM_MCP_ALLOWED_COMMANDS', 'DATABASE_TYPE', 'CUTTLELY_HARNESS_TURN_BUDGET_MS', 'LOG_LEVEL', 'NOPE'].sort()
        )
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
        expect((await app(OWNER).put('/api/v1/server-settings').send({ nope: true })).status).toBe(400)
    })

    it('never leaves the server without a way to sign in', async () => {
        state.hostKeys = []
        env = { CUTTLELY_DATA_DIR: env.CUTTLELY_DATA_DIR }
        const res = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_LOCAL_ADMIN: 'false' } })
        expect(res.status).toBe(409)
        expect(res.body.code).toBe('NO_WAY_IN')
        expect(
            (
                await app(OWNER)
                    .put('/api/v1/server-settings')
                    .send({ values: { CUTTLELY_LOCAL_ADMIN: 'true' } })
            ).status
        ).toBe(200)
    })

    it('keeps a secret this key cannot read when something else changes', async () => {
        writeSettingsFile(dir, { WORKOS_API_KEY: SECRET }, { key: 'an-older-key' })
        const before = readStoredValues(dir).WORKOS_API_KEY
        const view = await app(OWNER).get('/api/v1/server-settings')
        expect(view.body.settings.find((s: { key: string }) => s.key === 'WORKOS_API_KEY').secret).toEqual({ set: true, unreadable: true })
        const res = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_ANALYST: 'auto' } })
        expect(res.status).toBe(200)
        expect(readStoredValues(dir).WORKOS_API_KEY).toEqual(before)
        expect(readSettingsFile(dir, KEY).values.CUTTLELY_ANALYST).toBe('auto')
    })
})

describe('discard, history and restart', () => {
    it('puts the file back the way it was at start', async () => {
        writeSettingsFile(dir, { CUTTLELY_ANALYST: 'auto' }, { key: KEY })
        state.rawAtStart = fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
        state.atStart = { CUTTLELY_ANALYST: 'auto' }
        await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_ANALYST: '', CUTTLELY_VERSIONS: 'off' } })
        const res = await app(OWNER).post('/api/v1/server-settings/discard')
        expect(res.status).toBe(200)
        expect(readSettingsFile(dir, KEY).values).toEqual({ CUTTLELY_ANALYST: 'auto' })
        expect(res.body.restart.changed).toEqual([])
        const history = await app(OWNER).get('/api/v1/server-settings/history?limit=5')
        expect(history.body.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['discard', 'save'])
    })

    it('gives manual steps without the start script, and restarts in place with it', async () => {
        const manual = await app(OWNER).post('/api/v1/server-settings/restart')
        expect(manual.status).toBe(202)
        expect(manual.body.restarting).toBe(false)
        expect(manual.body.steps.length).toBeGreaterThan(0)
        env.CUTTLELY_SUPERVISED = '1'
        const handler = jest.fn(async () => undefined)
        setRestartHandler(handler)
        const res = await app(OWNER).post('/api/v1/server-settings/restart')
        expect(res.body.restarting).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(handler).toHaveBeenCalledTimes(1)
        expect(readHistory(dir)[0]).toMatchObject({ kind: 'restart', by: 'owner@example.com' })
    })

    it('tells queue mode to restart the workers too', async () => {
        env.MODE = 'queue'
        const res = await app(OWNER).get('/api/v1/server-settings')
        expect(res.body.restart.workers).toBe(true)
        expect(res.body.restart.steps[res.body.restart.steps.length - 1]).toMatch(/restart each worker/)
    })
})

describe('Try it again after safe boot', () => {
    it('puts back the set-aside settings for the next restart, once', async () => {
        writeSettingsFile(dir, { CUTTLELY_ANALYST: 'auto' }, { key: KEY })
        const good = fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
        writeSettingsFile(dir, { CUTTLELY_ANALYST: 'auto', CUTTLELY_VERSIONS: 'off' }, { key: KEY })
        fs.copyFileSync(path.join(dir, SETTINGS_FILE), path.join(dir, 'server.rolled-back.json'))
        fs.writeFileSync(path.join(dir, SETTINGS_FILE), good)
        state.rolledBack = true
        const before = await app(OWNER).get('/api/v1/server-settings')
        expect(before.body.retryAvailable).toBe(true)
        expect((await app(MEMBER).post('/api/v1/server-settings/retry')).status).toBe(403)
        const res = await app(OWNER).post('/api/v1/server-settings/retry')
        expect(res.status).toBe(200)
        expect(res.body.retryAvailable).toBe(false)
        expect(readSettingsFile(dir, KEY).values).toEqual({ CUTTLELY_ANALYST: 'auto', CUTTLELY_VERSIONS: 'off' })
        expect(readHistory(dir)[0]).toMatchObject({ kind: 'restore', by: 'owner@example.com' })
        expect((await app(OWNER).post('/api/v1/server-settings/retry')).status).toBe(404)
    })

    it('changes nothing when the set-aside copy is damaged', async () => {
        writeSettingsFile(dir, { CUTTLELY_ANALYST: 'auto' }, { key: KEY })
        const good = fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
        fs.writeFileSync(path.join(dir, 'server.rolled-back.json'), '{ not json')
        const res = await app(OWNER).post('/api/v1/server-settings/retry')
        expect(res.status).toBe(409)
        expect(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(good)
        expect(fs.existsSync(path.join(dir, 'server.rolled-back.json'))).toBe(true)
    })

    it('reports runs in progress and how long Restart waits for them', async () => {
        env.CUTTLELY_HARNESS_TURN_BUDGET_MS = '60000'
        const res = await app(OWNER).get('/api/v1/server-settings')
        expect(res.body.runs).toEqual({ inProgress: 0, waitSeconds: 60 })
    })
})

const OTHER_WORKSPACE = { id: 'other-1', email: 'other@example.com', activeWorkspaceId: 'team-b', permissions: ['chatflows:view'] }

describe('runtime limits and history', () => {
    it('applies a runtime limit without a restart and records who changed it', async () => {
        const res = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_LOGIN_FAILURE_LIMIT: '20' } })
        expect(res.status).toBe(200)
        const row = res.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_LOGIN_FAILURE_LIMIT')
        expect(row).toMatchObject({ runtime: true, value: '20', running: '20', changed: false })
        expect(res.body.restart.changed).not.toContain('CUTTLELY_LOGIN_FAILURE_LIMIT')
        expect(runtimeNumber('CUTTLELY_LOGIN_FAILURE_LIMIT', env)).toBe(20)
        const [entry] = readHistory(dir)
        expect(entry).toMatchObject({
            kind: 'save',
            by: 'owner@example.com',
            actorId: 'owner-1',
            event: 'server_setting.updated',
            outcome: 'ok'
        })
        expect(entry.changes).toContainEqual({ key: 'CUTTLELY_LOGIN_FAILURE_LIMIT', from: '', to: '20' })
    })

    it('refuses limits outside the range, a bad type, an unknown key, and idle longer than absolute', async () => {
        const range = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_LOGIN_FAILURE_LIMIT: '2' } })
        expect(range.status).toBe(400)
        expect(range.body.code).toBe('OUT_OF_RANGE')
        expect(range.body.errors).toEqual([
            { key: 'CUTTLELY_LOGIN_FAILURE_LIMIT', code: 'OUT_OF_RANGE', message: expect.stringMatching(/from 3 to 50/) }
        ])
        const typed = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_DRAIN_TIMEOUT_MS: 'soon' } })
        expect(typed.status).toBe(400)
        expect(typed.body.code).toBe('INVALID')
        const idle = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_SESSION_IDLE_MINUTES: '1440', CUTTLELY_SESSION_ABSOLUTE_HOURS: '1' } })
        expect(idle.status).toBe(400)
        expect(idle.body.code).toBe('CROSS_FIELD')
        expect(idle.body.errors.map((error: { key: string }) => error.key)).toContain('CUTTLELY_SESSION_IDLE_MINUTES')
        expect(JSON.stringify(idle.body)).not.toContain('changed')
        expect(fs.existsSync(path.join(dir, 'history.jsonl'))).toBe(false)
    })

    it('does not store a secret on a failed save or a history write that fails', async () => {
        const leaked = 'pw-made-up-for-the-bakery-9999'
        const invalid = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { WORKOS_API_KEY: leaked, CUTTLELY_LOGIN_FAILURE_LIMIT: 'nope' } })
        expect(invalid.status).toBe(400)
        expect(JSON.stringify(invalid.body)).not.toContain(leaked)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)

        const fsRename = (jest.requireActual('fs') as typeof fs).renameSync
        const rename = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to).endsWith('history.jsonl')) throw new Error('disk full')
            return fsRename(from, to)
        })
        try {
            const failed = await app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { WORKOS_API_KEY: leaked, CUTTLELY_LOGIN_FAILURE_LIMIT: '12' } })
            expect(failed.status).toBe(500)
            expect(failed.body.code).toBe('HISTORY_FAILED')
            expect(JSON.stringify(failed.body)).not.toContain(leaked)
            expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
            expect(fs.existsSync(path.join(dir, 'history.jsonl'))).toBe(false)
        } finally {
            rename.mockRestore()
        }
    })

    it('keeps old and new values in order when two saves overlap', async () => {
        const [first, second] = await Promise.all([
            app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { CUTTLELY_LOGIN_FAILURE_LIMIT: '20' } }),
            app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { CUTTLELY_LOGIN_FAILURE_LIMIT: '30' } })
        ])
        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        const saves = readHistory(dir).filter((entry) => entry.kind === 'save')
        expect(saves).toHaveLength(2)
        const newer = saves[0].changes?.find((change) => change.key === 'CUTTLELY_LOGIN_FAILURE_LIMIT')
        const older = saves[1].changes?.find((change) => change.key === 'CUTTLELY_LOGIN_FAILURE_LIMIT')
        expect(newer?.from).toBe(older?.to)
        expect([older?.to, newer?.to].sort()).toEqual(['20', '30'])
    })

    it('pages history for the organization owner and refuses everyone else', async () => {
        for (const value of ['11', '12', '13']) {
            expect(
                (
                    await app(OWNER)
                        .put('/api/v1/server-settings')
                        .send({ values: { CUTTLELY_LOGIN_FAILURE_LIMIT: value } })
                ).status
            ).toBe(200)
        }
        const page = await app(OWNER).get('/api/v1/server-settings/history?limit=2')
        expect(page.status).toBe(200)
        expect(page.body.entries).toHaveLength(2)
        expect(page.body.limit).toBe(2)
        expect(typeof page.body.nextCursor).toBe('string')
        const next = await app(OWNER).get(`/api/v1/server-settings/history?cursor=${encodeURIComponent(page.body.nextCursor)}`)
        expect(next.status).toBe(200)
        expect(next.body.entries).toHaveLength(1)
        expect(next.body.nextCursor).toBeNull()
        expect(next.body.limit).toBe(50)
        const capped = await app(OWNER).get('/api/v1/server-settings/history?limit=1000')
        expect(capped.body.limit).toBe(100)
        expect((await app(OWNER).get('/api/v1/server-settings/history?cursor=not-a-cursor')).status).toBe(400)
        expect((await app(OWNER).get('/api/v1/server-settings/history?cursor=not-a-cursor')).body.code).toBe('INVALID_CURSOR')
        expect((await app(OWNER).get('/api/v1/server-settings/history?limit=0')).status).toBe(400)
        expect((await app(null).get('/api/v1/server-settings/history')).status).toBe(401)
        expect((await app(WORKSPACE_ADMIN).get('/api/v1/server-settings/history')).status).toBe(403)
        expect((await app(OTHER_WORKSPACE).get('/api/v1/server-settings/history')).status).toBe(403)
        expect((await app(API_KEY).get('/api/v1/server-settings/history')).status).toBe(403)
        const denied = await app(WORKSPACE_ADMIN)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_SESSION_IDLE_MINUTES: '30' } })
        expect(denied.status).toBe(403)
        expect(readSettingsFile(dir, KEY).values.CUTTLELY_SESSION_IDLE_MINUTES).toBeUndefined()
        const ownerElsewhere = { ...OWNER, activeWorkspaceId: 'team-b' }
        expect((await app(ownerElsewhere).get('/api/v1/server-settings/history')).status).toBe(200)
    })

    it('treats an expired or invalid session as signed out, and a caller with no user id as forbidden', async () => {
        const expired = await gated({ attachIdentitySession: async () => null })
            .get('/api/v1/server-settings')
            .set('Cookie', 'cuttlely.local=not-a-real-session')
        const invalidToken = await gated({
            attachIdentitySession: async () => null,
            validateAPIKey: jest.fn(async () => ({ isValid: true, apiKey: { workspaceId: 'team-a', permissions: ['*'] } }))
        })
            .put('/api/v1/server-settings')
            .set('Authorization', 'Bearer not-a-real-token')
            .send({ values: { CUTTLELY_PUBLISH_CHECK: 'false' } })
        expect(expired.status).toBe(401)
        expect(expired.body).toEqual({ error: 'Unauthorized Access' })
        expect(invalidToken.status).toBe(401)
        expect(invalidToken.body).toEqual({ error: 'Unauthorized Access' })
        const nameless = { email: 'owner@example.com', activeWorkspaceId: 'team-a', permissions: [] }
        expect((await app(nameless).get('/api/v1/server-settings')).status).toBe(403)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('refuses a host-locked limit and does not record a change', async () => {
        state.hostKeys.push('CUTTLELY_SESSION_IDLE_MINUTES')
        env.CUTTLELY_SESSION_IDLE_MINUTES = '30'
        const res = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_SESSION_IDLE_MINUTES: '60' } })
        expect(res.status).toBe(409)
        expect(res.body.code).toBe('LOCKED')
        expect(res.body.errors[0].message).toMatch(/host/)
        expect(fs.existsSync(path.join(dir, 'history.jsonl'))).toBe(false)
        expect(env.CUTTLELY_SESSION_IDLE_MINUTES).toBe('30')
    })
})

describe('runtime limits on the settings API', () => {
    const previousData = process.env.CUTTLELY_DATA_DIR

    afterEach(() => {
        if (previousData === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previousData
        resetRuntimeLimitsForTests()
    })

    it('returns source, runtime, range and unit, and a save applies without a restart', async () => {
        process.env.CUTTLELY_DATA_DIR = env.CUTTLELY_DATA_DIR
        resetRuntimeLimitsForTests()
        const before = await app(OWNER).get('/api/v1/server-settings')
        const tokens = before.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_CHECK_MAX_TOKENS')
        expect(tokens).toMatchObject({
            runtime: true,
            source: 'default',
            unit: 'tokens',
            range: { min: 1000, max: 2000000 },
            value: '',
            effective: '100000',
            changed: false
        })
        const countDefault = before.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_CHECK_COUNT_DEFAULT')
        expect(countDefault.range).toEqual({ min: 1, max: 100 })
        const byKey = (body: { settings: Array<{ key: string; range: { min: number; max: number } }> }, key: string) =>
            body.settings.find((setting) => setting.key === key) as { range: { min: number; max: number } }
        expect(byKey(before.body, 'CUTTLELY_RATING_IMPORT_CAP').range).toEqual({ min: 50, max: 1000 })
        expect(byKey(before.body, 'CUTTLELY_RATING_SCAN_CAP').range).toEqual({ min: 500, max: 20000 })
        env.CUTTLELY_RATING_SCAN_CAP = '800'
        resetRuntimeLimitsForTests()
        const tighterScan = await app(OWNER).get('/api/v1/server-settings')
        expect(byKey(tighterScan.body, 'CUTTLELY_RATING_IMPORT_CAP').range).toEqual({ min: 50, max: 800 })
        expect(byKey(tighterScan.body, 'CUTTLELY_RATING_SCAN_CAP').range).toEqual({ min: 500, max: 20000 })
        delete env.CUTTLELY_RATING_SCAN_CAP
        env.CUTTLELY_RATING_IMPORT_CAP = '900'
        resetRuntimeLimitsForTests()
        const higherImport = await app(OWNER).get('/api/v1/server-settings')
        expect(byKey(higherImport.body, 'CUTTLELY_RATING_SCAN_CAP').range).toEqual({ min: 900, max: 20000 })
        expect(byKey(higherImport.body, 'CUTTLELY_RATING_IMPORT_CAP').range).toEqual({ min: 50, max: 1000 })
        delete env.CUTTLELY_RATING_IMPORT_CAP
        resetRuntimeLimitsForTests()
        env.CUTTLELY_CHECK_COUNT_MAX = '10'
        resetRuntimeLimitsForTests()
        const capped = await app(OWNER).get('/api/v1/server-settings')
        const cappedDefault = capped.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_CHECK_COUNT_DEFAULT')
        expect(cappedDefault.range).toEqual({ min: 1, max: 10 })
        delete env.CUTTLELY_CHECK_COUNT_MAX
        resetRuntimeLimitsForTests()
        env.CUTTLELY_CHECK_COUNT_MAX = '1'
        state.hostKeys = ['CUTTLELY_LOCAL_ADMIN', 'LOG_LEVEL', 'CUTTLELY_CHECK_COUNT_MAX']
        resetRuntimeLimitsForTests()
        const bounded = await app(OWNER).get('/api/v1/server-settings')
        const boundedDefault = bounded.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_CHECK_COUNT_DEFAULT')
        expect(boundedDefault).toMatchObject({
            source: 'bounded',
            boundedBy: 'CUTTLELY_CHECK_COUNT_MAX',
            locked: false,
            value: '1',
            effective: '1'
        })
        expect(boundedDefault.source).not.toBe('host')
        const boundedCap = bounded.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_CHECK_COUNT_MAX')
        expect(boundedCap).toMatchObject({ source: 'host', locked: true, value: '1' })
        expect(boundedCap.boundedBy).toBeUndefined()
        delete env.CUTTLELY_CHECK_COUNT_MAX
        state.hostKeys = ['CUTTLELY_LOCAL_ADMIN', 'LOG_LEVEL']
        resetRuntimeLimitsForTests()
        const saved = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_CHECK_MAX_TOKENS: 5000 } })
        expect(saved.status).toBe(200)
        const after = saved.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_CHECK_MAX_TOKENS')
        expect(after).toMatchObject({ source: 'panel', value: '5000', effective: '5000', changed: false, runtime: true })
        expect(saved.body.restart.changed).not.toContain('CUTTLELY_CHECK_MAX_TOKENS')
        expect(runtimeNumber('CUTTLELY_CHECK_MAX_TOKENS')).toBe(5000)
    })

    it('refuses an out of range value and a pair that does not hold, and saves nothing', async () => {
        const range = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_CHECK_MAX_SECONDS: '5' } })
        expect(range.status).toBe(400)
        expect(range.body).toMatchObject({
            code: 'OUT_OF_RANGE',
            key: 'CUTTLELY_CHECK_MAX_SECONDS',
            min: 10,
            max: 1800
        })
        expect(typeof range.body.reason).toBe('string')
        expect(range.body.reason).not.toContain('5')
        const fraction = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_CHECK_CONCURRENCY: '1.5' } })
        expect(fraction.status).toBe(400)
        expect(fraction.body.code).toBe('INVALID')
        expect(fraction.body.key).toBe('CUTTLELY_CHECK_CONCURRENCY')
        const pair = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_CHECK_COUNT_DEFAULT: '101' } })
        expect(pair.status).toBe(400)
        expect(pair.body).toMatchObject({
            code: 'CROSS_FIELD',
            key: 'CUTTLELY_CHECK_COUNT_DEFAULT',
            min: 1,
            max: 100
        })
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('lets a saved history cap override the environment variable and stays editable', async () => {
        const previousDir = process.env.CUTTLELY_DATA_DIR
        const previousKeep = process.env.CUTTLELY_HISTORY_KEEP
        process.env.CUTTLELY_DATA_DIR = env.CUTTLELY_DATA_DIR
        delete process.env.CUTTLELY_HISTORY_KEEP
        state.hostKeys.push('CUTTLELY_HISTORY_KEEP')
        env.CUTTLELY_HISTORY_KEEP = '2000'
        resetRuntimeLimitsForTests()
        try {
            const before = await app(OWNER).get('/api/v1/server-settings')
            const open = before.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_HISTORY_KEEP')
            expect(open).toMatchObject({
                section: 'security',
                group: 'History',
                label: 'Settings changes to keep',
                source: 'host',
                effective: '2000',
                locked: false,
                runtime: true
            })
            const low = await app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { CUTTLELY_HISTORY_KEEP: '99' } })
            expect(low.status).toBe(400)
            expect(low.body).toMatchObject({ code: 'OUT_OF_RANGE', min: 100, max: 10000 })
            const saved = await app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { CUTTLELY_HISTORY_KEEP: '250' } })
            expect(saved.status).toBe(200)
            const row = saved.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_HISTORY_KEEP')
            expect(row).toMatchObject({ source: 'panel', value: '250', effective: '250', locked: false })
            resetRuntimeLimitsForTests()
            expect(runtimeNumber('CUTTLELY_HISTORY_KEEP', env)).toBe(250)
        } finally {
            if (previousDir === undefined) delete process.env.CUTTLELY_DATA_DIR
            else process.env.CUTTLELY_DATA_DIR = previousDir
            if (previousKeep === undefined) delete process.env.CUTTLELY_HISTORY_KEEP
            else process.env.CUTTLELY_HISTORY_KEEP = previousKeep
            resetRuntimeLimitsForTests()
        }
    })

    it('refuses a history cap outside 100 to 10000 and applies one inside that range', async () => {
        const previousDir = process.env.CUTTLELY_DATA_DIR
        const previousKeep = process.env.CUTTLELY_HISTORY_KEEP
        process.env.CUTTLELY_DATA_DIR = env.CUTTLELY_DATA_DIR
        delete process.env.CUTTLELY_HISTORY_KEEP
        resetRuntimeLimitsForTests()
        try {
            const low = await app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { CUTTLELY_HISTORY_KEEP: '99' } })
            expect(low.status).toBe(400)
            expect(low.body).toMatchObject({ code: 'OUT_OF_RANGE', key: 'CUTTLELY_HISTORY_KEEP', min: 100, max: 10000 })
            const high = await app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { CUTTLELY_HISTORY_KEEP: '10001' } })
            expect(high.status).toBe(400)
            expect(high.body.code).toBe('OUT_OF_RANGE')
            const saved = await app(OWNER)
                .put('/api/v1/server-settings')
                .send({ values: { CUTTLELY_HISTORY_KEEP: '100' } })
            expect(saved.status).toBe(200)
            const row = saved.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_HISTORY_KEEP')
            expect(row).toMatchObject({ runtime: true, value: '100', effective: '100', changed: false, range: { min: 100, max: 10000 } })
            resetRuntimeLimitsForTests()
            expect(runtimeNumber('CUTTLELY_HISTORY_KEEP', env)).toBe(100)
        } finally {
            if (previousDir === undefined) delete process.env.CUTTLELY_DATA_DIR
            else process.env.CUTTLELY_DATA_DIR = previousDir
            if (previousKeep === undefined) delete process.env.CUTTLELY_HISTORY_KEEP
            else process.env.CUTTLELY_HISTORY_KEEP = previousKeep
            resetRuntimeLimitsForTests()
        }
    })

    it('answers 200 when the settings file is corrupt', async () => {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, SETTINGS_FILE), '{', 'utf8')
        const res = await app(OWNER).get('/api/v1/server-settings')
        expect(res.status).toBe(200)
        const tokens = res.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_CHECK_MAX_TOKENS')
        expect(tokens).toMatchObject({ source: 'default', effective: '100000' })
    })

    it('saves the publish check switch, records it, and ignores a workspace id', async () => {
        process.env.CUTTLELY_DATA_DIR = env.CUTTLELY_DATA_DIR
        resetRuntimeLimitsForTests()
        const before = await app(OWNER).get('/api/v1/server-settings')
        expect(before.body.workspaceId).toBeUndefined()
        expect(before.body.readOnly.length).toBeGreaterThan(0)
        expect(before.body.readOnly.length).toBeLessThan(200)
        const row = before.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_PUBLISH_CHECK')
        expect(row).toMatchObject({
            type: 'switch',
            runtime: true,
            section: 'testing',
            source: 'default',
            value: '',
            effective: 'true',
            on: 'true',
            off: 'false',
            locked: false
        })
        const saved = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_PUBLISH_CHECK: false }, workspaceId: 'team-b' })
        expect(saved.status).toBe(200)
        const after = saved.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_PUBLISH_CHECK')
        expect(after).toMatchObject({ source: 'panel', value: 'false', effective: 'false' })
        expect(readSettingsFile(dir, KEY).values).toEqual({ CUTTLELY_PUBLISH_CHECK: 'false' })
        expect(JSON.stringify(readSettingsFile(dir, KEY))).not.toContain('team-b')
        const history = await app(OWNER).get('/api/v1/server-settings/history?limit=5')
        expect(history.body.entries[0].changes).toEqual([{ key: 'CUTTLELY_PUBLISH_CHECK', from: '', to: 'false' }])
        expect(history.body.entries[0].event).toBe('server_setting.updated')
        const cleared = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_PUBLISH_CHECK: null } })
        expect(cleared.status).toBe(200)
        expect(readSettingsFile(dir, KEY).values.CUTTLELY_PUBLISH_CHECK).toBeUndefined()
        resetRuntimeLimitsForTests()
        expect(publishCheckEnabled(env)).toBe(true)
    })

    it('refuses a bad publish-check value and a host lock, and does not scope the save to a workspace', async () => {
        process.env.CUTTLELY_DATA_DIR = env.CUTTLELY_DATA_DIR
        const cases: Array<{ body: object; code: string }> = [
            { body: { values: { CUTTLELY_PUBLISH_CHECK: 'yes' } }, code: 'INVALID' },
            { body: { values: { CUTTLELY_PUBLISH_CHECK: 'TRUE' } }, code: 'INVALID' },
            { body: { values: { CUTTLELY_PUBLISH_CHECK: 1 } }, code: 'INVALID' },
            { body: { values: { CUTTLELY_PUBLISH_CHECK: { on: true } } }, code: 'INVALID' },
            { body: { values: { CUTTLELY_NOT_A_REAL_SETTING: '1' } }, code: 'INVALID' }
        ]
        for (const item of cases) {
            const res = await app(OWNER).put('/api/v1/server-settings').send(item.body)
            expect(res.status).toBe(400)
            expect(res.body.code).toBe(item.code)
        }
        const empty = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_PUBLISH_CHECK: '' } })
        expect(empty.status).toBe(200)
        state.hostKeys.push('CUTTLELY_PUBLISH_CHECK')
        env.CUTTLELY_PUBLISH_CHECK = 'false'
        resetRuntimeLimitsForTests()
        const locked = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { CUTTLELY_PUBLISH_CHECK: 'true' } })
        expect(locked.status).toBe(409)
        expect(locked.body.code).toBe('LOCKED')
        expect(locked.body.message).toMatch(/set by the host/)
        expect(readSettingsFile(dir, KEY).values.CUTTLELY_PUBLISH_CHECK).toBeUndefined()
        const view = await app(OWNER).get('/api/v1/server-settings')
        const row = view.body.settings.find((setting: { key: string }) => setting.key === 'CUTTLELY_PUBLISH_CHECK')
        expect(row).toMatchObject({ locked: true, source: 'host', effective: 'false' })
        const scoped = await app(OTHER_WORKSPACE)
            .put('/api/v1/workspaces/team-b/server-settings')
            .send({ values: { CUTTLELY_PUBLISH_CHECK: 'true' } })
        expect(scoped.status).toBe(404)
        const missed = await app(OWNER).get('/api/v1/server-settings/workspaces/team-b')
        expect(missed.status).toBe(404)
        expect((await app(OTHER_WORKSPACE).get('/api/v1/server-settings')).status).toBe(403)
        expect(
            (
                await app(OTHER_WORKSPACE)
                    .put('/api/v1/server-settings')
                    .send({ values: { CUTTLELY_PUBLISH_CHECK: 'true' } })
            ).status
        ).toBe(403)
    })
})

const FAKE_KEY = 'fake-langsmith-key-b3'
const FAKE_REDIS = 'redis://fake-user:fake-pass-b3@example.invalid:6399/0'

describe('read-only env status', () => {
    it('is owner-only and hidden from another workspace, a member, an API key, and a signed-out caller', async () => {
        env.LANGSMITH_API_KEY = FAKE_KEY
        env.REDIS_URL = FAKE_REDIS
        const listed = await app(OWNER).get('/api/v1/server-settings/read-only')
        expect(listed.status).toBe(200)
        expect(listed.body.scope).toBe('instance')
        expect(listed.headers['cache-control']).toBe('no-store')
        expect(JSON.stringify(listed.body)).not.toContain(FAKE_KEY)
        expect(JSON.stringify(listed.body)).not.toContain('fake-pass-b3')
        expect(JSON.stringify(listed.body)).not.toContain('example.invalid')
        const one = await app(OWNER).get('/api/v1/server-settings/read-only/LANGSMITH_API_KEY')
        expect(one.body).toEqual({ key: 'LANGSMITH_API_KEY', set: true, source: 'env', readOnly: true })
        expect(Object.keys(one.body).sort()).toEqual(['key', 'readOnly', 'set', 'source'])
        const level = (await app(OWNER).get('/api/v1/server-settings')).body.settings.find(
            (setting: { key: string }) => setting.key === 'LOG_LEVEL'
        )
        expect(level).toHaveProperty('value', 'warn')
        expect((await app(OWNER).get('/api/v1/server-settings/read-only/LOG_LEVEL')).status).toBe(404)
        expect((await app(MEMBER).get('/api/v1/server-settings/read-only')).status).toBe(403)
        expect((await app(WORKSPACE_ADMIN).get('/api/v1/server-settings/read-only')).status).toBe(403)
        expect((await app(WORKSPACE_ADMIN).put('/api/v1/server-settings/read-only/REDIS_URL').send({ value: FAKE_REDIS })).status).toBe(403)
        expect((await app(MEMBER).get('/api/v1/server-settings/read-only/REDIS_URL')).status).toBe(403)
        expect((await app(API_KEY).get('/api/v1/server-settings/read-only')).status).toBe(403)
        expect((await app(null).get('/api/v1/server-settings/read-only')).status).toBe(401)
        setTeamPermissionLookup({
            accessFor: async (userId, workspaceId) => {
                if (userId === 'owner-1' && workspaceId === 'team-a') return { owner: true, permissions: null }
                return { owner: false, permissions: ['chatflows:view'] }
            }
        })
        const wrongWorkspace = { ...OWNER, activeWorkspaceId: 'team-b', permissions: ['*'] }
        const denied = await app(wrongWorkspace).get('/api/v1/server-settings/read-only')
        expect(denied.status).toBe(403)
        expect(JSON.stringify(denied.body)).not.toContain(FAKE_KEY)
        expect((await app(OWNER).get('/api/v1/server-settings/read-only')).status).toBe(200)
    })

    it('rejects PUT, PATCH, and DELETE and does not echo the submitted text', async () => {
        const client = app(OWNER)
        const put = await client.put('/api/v1/server-settings/read-only/LANGSMITH_API_KEY').send({ value: FAKE_KEY })
        expect(put.status).toBe(400)
        expect(put.body).toMatchObject({
            code: 'READ_ONLY',
            message: 'This setting cannot be changed.',
            errors: [{ key: 'LANGSMITH_API_KEY', code: 'READ_ONLY', message: 'This setting cannot be changed.' }]
        })
        const patch = await client.patch('/api/v1/server-settings/read-only/REDIS_URL').send({ value: FAKE_REDIS })
        expect(patch.status).toBe(400)
        expect(patch.body.code).toBe('READ_ONLY')
        const deleted = await client.delete('/api/v1/server-settings/read-only/TOKEN_HASH_SECRET').send({ value: FAKE_KEY })
        expect(deleted.status).toBe(400)
        expect(deleted.body.code).toBe('READ_ONLY')
        const collection = await client.patch('/api/v1/server-settings/read-only').send({ value: FAKE_KEY })
        expect(collection.status).toBe(400)
        expect(collection.body.code).toBe('READ_ONLY')
        const saved = await client.put('/api/v1/server-settings').send({ values: { PORT: FAKE_KEY, LANGSMITH_API_KEY: FAKE_KEY } })
        expect(saved.status).toBe(400)
        expect(saved.body.code).toBe('READ_ONLY')
        expect(saved.body.errors.map((item: { key: string }) => item.key).sort()).toEqual(['LANGSMITH_API_KEY', 'PORT'])
        const mixed = await client.patch('/api/v1/server-settings').send({ values: { REDIS_PASSWORD: FAKE_REDIS } })
        expect(mixed.status).toBe(400)
        expect(mixed.body.code).toBe('READ_ONLY')
        const ordinary = await client.patch('/api/v1/server-settings').send({ values: { LOG_LEVEL: 'debug' } })
        expect(ordinary.status).toBe(405)
        expect(ordinary.body.code).toBe('METHOD_NOT_ALLOWED')
        const unknown = await client.delete('/api/v1/server-settings/read-only/LOG_LEVEL').send({ value: FAKE_KEY })
        expect(unknown.status).toBe(404)
        expect(unknown.body.code).toBe('NOT_FOUND')
        const pasted = `https://user:${FAKE_KEY}@example.invalid/hook?token=${FAKE_KEY}`
        const invalid = await client.put('/api/v1/server-settings').send({
            values: {
                LANGSMITH_ENDPOINT: pasted,
                LANGSMITH_PROJECT: pasted,
                LOG_SANITIZE_BODY_FIELDS: pasted
            }
        })
        expect(invalid.status).toBe(400)
        expect(invalid.body.errors.map((item: { key: string; code: string }) => [item.key, item.code]).sort()).toEqual([
            ['LANGSMITH_ENDPOINT', 'INVALID_URL'],
            ['LANGSMITH_PROJECT', 'INVALID_NAME'],
            ['LOG_SANITIZE_BODY_FIELDS', 'INVALID_NAME']
        ])
        const bodies = JSON.stringify([put.body, patch.body, deleted.body, saved.body, invalid.body])
        expect(bodies).not.toContain(FAKE_KEY)
        expect(bodies).not.toContain('fake-pass-b3')
        expect(bodies).not.toContain('example.invalid')
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
        expect(fs.existsSync(path.join(dir, 'history.jsonl'))).toBe(false)
    })
})
