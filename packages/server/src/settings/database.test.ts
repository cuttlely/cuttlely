import express, { Request } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { setTeamPermissionLookup } from '../identity/rbac'
import { StartState } from './apply'
import { PgClient, TestDrivers, defaultDrivers } from './connection'
import { PREVIOUS_DATABASE_FILE } from './database-summary'
import { readHistory } from './history'
import { setRestartHandler } from './restart'
import { SETTINGS_FILE, readSettingsFile, writeSettingsFile } from './store'

jest.mock('./bootstrap', () => ({
    startState: { dir: '', hostKeys: [], atStart: {}, applied: [], unreadable: [], problems: [] }
}))

import router, { setConnectionDrivers, setServerSettingsDeps } from '../routes/server-settings/index'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const PASSWORD = 'pw-made-up-for-the-bakery-0001'
const OWNER = { id: 'owner-1', email: 'owner@rosas-bakery.example', activeWorkspaceId: 'team-a', permissions: [] }
const POSTGRES = {
    DATABASE_TYPE: 'postgres',
    DATABASE_HOST: 'db.rosas-bakery.example',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'bakery',
    DATABASE_USER: 'cuttlely',
    DATABASE_PASSWORD: PASSWORD
}

let data: string
let dir: string
let env: Record<string, string | undefined>
let state: StartState
let tables: string[]
let connectError: unknown
let restarts: number
let pgPasswords: unknown[]

function drivers(): TestDrivers {
    return {
        ...defaultDrivers(),
        pg: (config) => {
            pgPasswords.push(config.password)
            const client: PgClient = {
                connect: async () => {
                    if (connectError) throw connectError
                },
                query: async (text) => {
                    if (text.includes('version()')) return { rows: [{ version: 'PostgreSQL 16.4' }] }
                    if (text.includes('has_schema_privilege')) return { rows: [{ allowed: true }] }
                    if (text.includes('information_schema.tables')) return { rows: tables.map((name) => ({ table_name: name })) }
                    return { rows: [] }
                },
                end: async () => undefined
            }
            return client
        },
        home: () => data
    }
}

function app() {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        ;(req as Request).user = OWNER as unknown as Express.User
        next()
    })
    server.use('/api/v1/server-settings', router)
    return request(server)
}

const post = (route: string, body: object) => app().post(`/api/v1/server-settings/database/${route}`).send(body)

beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-db-switch-'))
    dir = path.join(data, 'settings')
    env = { CUTTLELY_DATA_DIR: data, CUTTLELY_LOCAL_ADMIN: 'true', CUTTLELY_SUPERVISED: '1', CUTTLELY_INSTALL: 'docker' }
    state = {
        dir,
        ignored: false,
        byStartScript: false,
        hostKeys: ['CUTTLELY_LOCAL_ADMIN'],
        atStart: {},
        applied: [],
        unreadable: [],
        problems: [],
        rawAtStart: null
    }
    tables = []
    connectError = null
    restarts = 0
    pgPasswords = []
    setServerSettingsDeps(() => ({ env, state, key: async () => KEY }))
    setConnectionDrivers(drivers)
    setRestartHandler(async () => {
        restarts += 1
    })
    setTeamPermissionLookup({ accessFor: async (userId) => ({ owner: userId === 'owner-1', permissions: [] }) })
})

afterEach(() => {
    setTeamPermissionLookup(null)
    setRestartHandler(null)
})

describe('checking a new database', () => {
    it('tests it, says it is empty and how the owner gets back in, and saves nothing', async () => {
        const res = await post('check', { values: POSTGRES })
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({
            canSwitch: true,
            same: false,
            current: { type: 'sqlite', label: 'SQLite, on this server' },
            next: { type: 'postgres', label: 'Postgres, bakery on db.rosas-bakery.example' },
            test: { ok: true, target: { kind: 'empty' } }
        })
        expect(res.body.signIn.text).toMatch(/docker compose logs cuttlely/)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
        expect(JSON.stringify(res.body)).not.toContain(PASSWORD)
    })

    it('knows a database Cuttlely already uses, and the one it runs on now', async () => {
        tables = ['chat_flow', 'migrations']
        expect((await post('check', { values: POSTGRES })).body.signIn.text).toMatch(/its own accounts/)
        const same = (await post('check', { values: { DATABASE_TYPE: 'sqlite' } })).body
        expect(same).toMatchObject({ same: true, canSwitch: false })
    })

    it('refuses a database with somebody else tables, or one that does not answer', async () => {
        tables = ['orders']
        expect((await post('check', { values: POSTGRES })).body.canSwitch).toBe(false)
        tables = []
        connectError = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
        expect((await post('check', { values: POSTGRES })).body).toMatchObject({ canSwitch: false, test: { ok: false } })
    })

    it('needs a way to create the owner on an empty database', async () => {
        env.CUTTLELY_LOCAL_ADMIN = 'false'
        const res = (await post('check', { values: POSTGRES })).body
        expect(res.canSwitch).toBe(false)
        expect(res.signIn.ok).toBe(false)
    })

    it('stays out of the way when the host sets the database', async () => {
        state.hostKeys.push('DATABASE_TYPE')
        env.DATABASE_TYPE = 'sqlite'
        expect((await post('check', { values: POSTGRES })).status).toBe(409)
    })
})

describe('switching', () => {
    it('needs RESTART typed exactly', async () => {
        expect((await post('switch', { values: POSTGRES })).status).toBe(400)
        expect((await post('switch', { values: POSTGRES, confirm: 'restart' })).status).toBe(400)
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('switches after a passing test, keeps the previous database and restarts', async () => {
        const res = await post('switch', { values: POSTGRES, confirm: 'RESTART' })
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ switched: true, restarting: true })
        expect(readSettingsFile(dir, KEY).values).toMatchObject(POSTGRES)
        expect(fs.existsSync(path.join(dir, PREVIOUS_DATABASE_FILE))).toBe(true)
        expect(readHistory(dir, 5)[1].note).toMatch(/Switched the database to Postgres, bakery/)
        const view = (await app().get('/api/v1/server-settings')).body
        expect(view.database).toMatchObject({
            saved: { type: 'postgres' },
            running: { type: 'sqlite' },
            previous: { type: 'sqlite', label: 'SQLite, on this server' }
        })
    })

    it('changes nothing when the test fails', async () => {
        connectError = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
        const res = await post('switch', { values: POSTGRES, confirm: 'RESTART' })
        expect(res.status).toBe(409)
        expect(res.body.message).toBe('The new database did not pass the test, so nothing changed.')
        expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    })

    it('gives the manual steps when it cannot restart by itself', async () => {
        delete env.CUTTLELY_SUPERVISED
        const res = (await post('switch', { values: POSTGRES, confirm: 'RESTART' })).body
        expect(res).toMatchObject({ switched: true, restarting: false })
        expect(res.steps[0]).toMatch(/docker compose restart cuttlely/)
    })

    it('switches back to the previous database, and back again', async () => {
        await post('switch', { values: POSTGRES, confirm: 'RESTART' })
        const back = await post('restore', { confirm: 'RESTART' })
        expect(back.status).toBe(200)
        expect(readSettingsFile(dir, KEY).values.DATABASE_TYPE).toBe('sqlite')
        expect(readSettingsFile(dir, KEY).values.DATABASE_PASSWORD).toBeUndefined()
        const again = await post('restore', { confirm: 'RESTART' })
        expect(again.status).toBe(200)
        expect(readSettingsFile(dir, KEY).values).toMatchObject(POSTGRES)
        expect(pgPasswords.at(-1)).toBe(PASSWORD)
    })

    it('keeps a saved password when the page leaves it blank', async () => {
        writeSettingsFile(dir, { ...POSTGRES, DATABASE_HOST: 'old-db.example' }, { key: KEY, by: 'owner' })
        tables = ['chat_flow']
        await post('switch', { values: { ...POSTGRES, DATABASE_PASSWORD: '' }, confirm: 'RESTART' })
        expect(pgPasswords[0]).toBe(PASSWORD)
        expect(readSettingsFile(dir, KEY).values).toMatchObject({ DATABASE_HOST: 'db.rosas-bakery.example', DATABASE_PASSWORD: PASSWORD })
    })

    it('says so when there is nothing to switch back to', async () => {
        expect((await post('restore', { confirm: 'RESTART' })).status).toBe(404)
    })
})
