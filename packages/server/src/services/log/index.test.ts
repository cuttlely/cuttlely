import express, { Request } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import errorHandlerMiddleware from '../../middlewares/errors'
import { setTeamPermissionLookup } from '../../identity/rbac'
import router from '../../routes/log'
import { LOG_FILE_BYTES, LOG_MAX_LINES } from './index'

const OWNER = { id: 'owner-1', activeWorkspaceId: 'team-a', permissions: [] as string[] }
const MEMBER = { id: 'member-1', activeWorkspaceId: 'team-a', permissions: ['chatflows:view'] }
const LOG_ADMIN = { id: 'admin-2', activeWorkspaceId: 'team-a', permissions: ['logs:view'] }
const API_KEY = { permissions: ['logs:view'], activeWorkspaceId: 'team-a' }

const STAMP = '2026-10-12-15'
const OUTSIDE = 'outside-file-marker-should-not-leak'
const SECRET_URL = 'postgres://app:s3cret-pass@db.example.com:5432/app'
const SECRET_BEARER = 'sk-testkeyvalue0001abcd'
const SECRET_KEY = 'aB3dE9fG1hJ2kL4mN6pQ'
const SECRET_PASSWORD = 'pX7kQ9mN2vL4sT8w'
const HEAD = 'HEAD-MARKER-NOT-IN-TAIL'
const TAIL = 'TAIL-MARKER-KEPT'

let root: string
let previousLogPath: string | undefined

function app(user: object | null) {
    const server = express()
    server.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        next()
    })
    server.use('/api/v1/logs', router)
    server.use(errorHandlerMiddleware)
    return request(server)
}

function writeLog(dir: string, name: string, body: string) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-logs-'))
    previousLogPath = process.env.LOG_PATH
    process.env.LOG_PATH = path.join(root, 'logs')
    setTeamPermissionLookup({
        accessFor: async (userId) => {
            if (userId === 'owner-1') return { owner: true, permissions: [] }
            if (userId === 'admin-2') return { owner: false, permissions: ['logs:view'] }
            if (userId === 'member-1') return { owner: false, permissions: ['chatflows:view'] }
            return { owner: false, permissions: null }
        }
    })
})

afterEach(() => {
    setTeamPermissionLookup(null)
    if (previousLogPath === undefined) delete process.env.LOG_PATH
    else process.env.LOG_PATH = previousLogPath
    fs.rmSync(root, { recursive: true, force: true })
})

describe('who can read server logs', () => {
    it('lets an owner and a role with logs:view read lines, and refuses everyone else', async () => {
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, `2026-10-12 15:00:00 [INFO]: bakery oven ready\n`)
        const owner = await app(OWNER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}`)
        expect(owner.status).toBe(200)
        expect(owner.headers['cache-control']).toBe('no-store')
        expect(owner.body.configured).toBe(true)
        expect(owner.body.lines.join('\n')).toContain('bakery oven ready')

        const granted = await app(LOG_ADMIN).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}&level=info`)
        expect(granted.status).toBe(200)
        expect(granted.body.lines.join('\n')).toContain('bakery oven ready')

        expect((await app(MEMBER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}`)).status).toBe(403)
        expect((await app(API_KEY).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}`)).status).toBe(403)
        expect((await app(null).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}`)).status).toBe(401)
    })
})

describe('reading only the log directory', () => {
    it('refuses a date that is not an hour stamp and does not follow a symlink out of the directory', async () => {
        const logs = process.env.LOG_PATH as string
        fs.mkdirSync(logs, { recursive: true })
        fs.writeFileSync(path.join(root, 'secret.txt'), OUTSIDE)
        fs.writeFileSync(path.join(root, `server.log.${STAMP}`), OUTSIDE)
        fs.symlinkSync(path.join(root, 'secret.txt'), path.join(logs, `server.log.${STAMP}`))
        writeLog(logs, 'notes.txt', OUTSIDE)

        const traversal = await app(OWNER).get('/api/v1/logs').query({ startDate: `../secret.txt`, endDate: STAMP })
        expect(traversal.status).toBe(400)
        expect(JSON.stringify(traversal.body)).not.toContain(OUTSIDE)

        const nested = await app(OWNER)
            .get('/api/v1/logs')
            .query({
                startDate: `${STAMP}/../../secret.txt`,
                endDate: STAMP
            })
        expect(nested.status).toBe(400)
        expect(JSON.stringify(nested.body)).not.toContain(OUTSIDE)

        const symlink = await app(OWNER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}`)
        expect(symlink.status).toBe(200)
        expect(JSON.stringify(symlink.body)).not.toContain(OUTSIDE)
        expect(symlink.body.lines).toEqual([])
    })

    it('says when no log directory is configured', async () => {
        process.env.LOG_PATH = path.join(root, 'missing')
        const res = await app(OWNER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}`)
        expect(res.status).toBe(200)
        expect(res.body.configured).toBe(false)
        expect(res.body.lines).toEqual([])
        expect(res.body.message).toContain('LOG_PATH')
    })
})

describe('masking and caps', () => {
    it('masks secrets in sample lines', async () => {
        const body = [
            `2026-10-12 15:00:00 [INFO]: connected ${SECRET_URL}`,
            `2026-10-12 15:00:01 [ERROR]: Authorization: Bearer ${SECRET_BEARER}`,
            `2026-10-12 15:00:02 [WARN]: api_key=${SECRET_KEY}`,
            `2026-10-12 15:00:03 [INFO]: password is ${SECRET_PASSWORD}`
        ].join('\n')
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, body + '\n')
        const res = await app(OWNER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}&level=debug`)
        expect(res.status).toBe(200)
        const text = res.body.lines.join('\n')
        expect(text).not.toContain('s3cret-pass')
        expect(text).not.toContain(SECRET_BEARER)
        expect(text).not.toContain(SECRET_KEY)
        expect(text).not.toContain(SECRET_PASSWORD)
        expect(text).toContain('[secret hidden]')
        expect(text).toContain('connected postgres://app:')
    })

    it('filters by level and keeps the line under an error', async () => {
        const body = [
            '2026-10-12 15:00:00 [INFO]: quiet hour',
            '2026-10-12 15:01:00 [ERROR]: oven failed',
            'stack line stays with the error'
        ].join('\n')
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, body + '\n')
        const res = await app(OWNER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}&level=error`)
        expect(res.body.lines).toEqual(['2026-10-12 15:01:00 [ERROR]: oven failed', 'stack line stays with the error'])
    })

    it('caps a large file to its tail', async () => {
        const padding = 'x'.repeat(80)
        const lines = [HEAD]
        while (Buffer.byteLength(lines.join('\n')) <= LOG_FILE_BYTES + 4096) lines.push(padding)
        lines.push(TAIL)
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, lines.join('\n') + '\n')
        const res = await app(OWNER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}&level=debug`)
        expect(res.status).toBe(200)
        expect(res.body.truncated).toBe(true)
        expect(res.body.lines.length).toBeLessThanOrEqual(LOG_MAX_LINES)
        expect(res.body.lines.join('\n')).toContain(TAIL)
        expect(res.body.lines.join('\n')).not.toContain(HEAD)
        expect(Buffer.byteLength(res.body.lines.join('\n'))).toBeLessThanOrEqual(LOG_FILE_BYTES)
    })
})
