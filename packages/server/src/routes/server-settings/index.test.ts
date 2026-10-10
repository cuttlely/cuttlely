import express, { Request } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { setTeamPermissionLookup } from '../../identity/rbac'
import { isServerSettingsUrl } from '../../settings/redact'
import { StartState } from '../../settings/apply'
import { readHistory } from '../../settings/history'
import { resetRestartRequest, setRestartHandler } from '../../settings/restart'
import { resetRuns } from '../../settings/runs'
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
})

describe('who can use server settings', () => {
    it('lets the owner in and keeps everyone else out, including API keys', async () => {
        expect((await app(OWNER).get('/api/v1/server-settings')).status).toBe(200)
        expect((await app(MEMBER).get('/api/v1/server-settings')).status).toBe(403)
        expect((await app(API_KEY).get('/api/v1/server-settings')).status).toBe(403)
        expect((await app(null).get('/api/v1/server-settings')).status).toBe(401)
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
        expect(entry.changes).toContainEqual({ key: 'WORKOS_API_KEY', secret: 'set' })
        expect(JSON.stringify(entry)).not.toContain(SECRET)
        const removed = await app(OWNER)
            .put('/api/v1/server-settings')
            .send({ values: { WORKOS_API_KEY: '' } })
        expect(removed.status).toBe(200)
        expect(readHistory(dir)[0].changes).toEqual([{ key: 'WORKOS_API_KEY', secret: 'removed' }])
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
