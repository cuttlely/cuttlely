import express, { Request } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import errorHandlerMiddleware from '../../middlewares/errors'
import { setTeamPermissionLookup } from '../../identity/rbac'
import router from '../../routes/log'
import logService, { stampsForRange } from './index'

/** Small stand-in for the published caps. The file is still larger than one read. */
const TEST_LIMITS = { fileBytes: 48, maxBytes: 48, maxLines: 8 }

function overCap(head: string, tail: string): string {
    return `${head}\n${'x'.repeat(TEST_LIMITS.fileBytes)}\n${tail}\n`
}

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
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, overCap(HEAD, TAIL))
        const result = await logService.getLogs({
            startDate: STAMP,
            endDate: STAMP,
            level: 'debug',
            limits: TEST_LIMITS
        })
        expect(result.truncated).toBe(true)
        const shown = result.lines.join('\n')
        expect(shown).toContain(TAIL)
        expect(shown).not.toContain(HEAD)
        expect(result.lines.length).toBeLessThanOrEqual(TEST_LIMITS.maxLines)
        expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(TEST_LIMITS.fileBytes)
    })

    it('masks a multiline private key before the lines are split', async () => {
        const bodyLine = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'
        const begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
        const footer = '-----END ' + 'RSA PRIVATE KEY-----'
        const pem = [begin, bodyLine, bodyLine, footer].join('\n')
        const text = ['2026-10-12 15:00:00 [INFO]: dumped key', pem, '2026-10-12 15:00:01 [INFO]: still here'].join('\n')
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, text + '\n')
        const res = await app(OWNER).get(`/api/v1/logs?startDate=${STAMP}&endDate=${STAMP}&level=debug`)
        expect(res.status).toBe(200)
        const shown = res.body.lines.join('\n')
        expect(shown).not.toContain(bodyLine)
        expect(shown).not.toContain(footer)
        expect(shown).not.toContain('PRIVATE KEY')
        expect(shown).toContain('[secret hidden]')
        expect(shown).toContain('still here')
    })

    it('reads newer rotation segments before the cap', async () => {
        const dir = process.env.LOG_PATH as string
        const limits = { fileBytes: 40, maxBytes: 24 }
        for (let index = 0; index <= 2; index += 1) {
            const marker = index === 2 ? 'LATEST-SEGMENT' : `SEG-${index}`
            const name = index === 0 ? `server.log.${STAMP}` : `server.log.${STAMP}.${index}`
            writeLog(dir, name, overCap(marker, `${marker}-END`))
        }
        const result = await logService.getLogs({ startDate: STAMP, endDate: STAMP, level: 'debug', limits })
        expect(result.truncated).toBe(true)
        const shown = result.lines.join('\n')
        expect(shown).toContain('LATEST-SEGMENT-END')
        expect(shown).not.toContain('SEG-0-END')
        expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(limits.fileBytes)
    })

    it('a tail cut inside a private key does not leak the body', async () => {
        const bodyLine = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'
        const begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
        const footer = '-----END ' + 'RSA PRIVATE KEY-----'
        const after = '2026-10-12 15:00:02 [INFO]: after the cut'
        const pem = [begin, bodyLine, bodyLine, bodyLine, bodyLine, footer].join('\n')
        const file = `${'p'.repeat(400)}\n${pem}\n${after}\n`
        const limits = { fileBytes: 140, maxBytes: 140 }
        const rawTail = file.slice(-limits.fileBytes)
        expect(rawTail).not.toContain('BEGIN')
        expect(rawTail).toContain(bodyLine)
        expect(rawTail).toContain('END')
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, file)
        const result = await logService.getLogs({ startDate: STAMP, endDate: STAMP, level: 'debug', limits })
        const shown = result.lines.join('\n')
        expect(result.truncated).toBe(true)
        expect(shown).not.toContain(bodyLine)
        expect(shown).not.toContain(footer)
        expect(shown).not.toContain('PRIVATE KEY')
        expect(shown).toContain('[secret hidden]')
        expect(shown).toContain('after the cut')
    })
})

describe('server clock for Last hour', () => {
    it('Last hour uses the server clock, not a browser offset', async () => {
        const now = new Date()
        const serverStamp = stampsForRange('1h', now).end
        const browser = new Date(now.getTime() - 8 * 60 * 60 * 1000)
        const browserStamp = stampsForRange('1h', browser).end
        expect(browserStamp).not.toBe(serverStamp)
        const dir = process.env.LOG_PATH as string
        writeLog(dir, `server.log.${serverStamp}`, '2026-10-12 15:00:00 [INFO]: SERVER-LOCAL-HOUR\n')
        writeLog(dir, `server.log.${browserStamp}`, '2026-10-12 07:00:00 [INFO]: BROWSER-OFFSET-HOUR\n')
        const res = await app(OWNER).get('/api/v1/logs?range=1h&level=debug')
        expect(res.status).toBe(200)
        const shown = res.body.lines.join('\n')
        expect(shown).toContain('SERVER-LOCAL-HOUR')
        expect(shown).not.toContain('BROWSER-OFFSET-HOUR')
    })

    it('a later refresh window includes the new hour', () => {
        const first = stampsForRange('1h', new Date(2026, 9, 12, 15, 10, 0))
        const later = stampsForRange('1h', new Date(2026, 9, 12, 16, 5, 0))
        expect(first).toEqual({ start: '2026-10-12-14', end: '2026-10-12-15' })
        expect(later).toEqual({ start: '2026-10-12-15', end: '2026-10-12-16' })
    })
})

describe('a file larger than the cap', () => {
    it('returns a capped result on every read of a file larger than the cap', async () => {
        writeLog(process.env.LOG_PATH as string, `server.log.${STAMP}`, overCap('HEAD', 'TAIL-OVER-TWO-MEG'))
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const result = await logService.getLogs({
                startDate: STAMP,
                endDate: STAMP,
                level: 'info',
                limits: TEST_LIMITS
            })
            expect(result.truncated).toBe(true)
            const shown = result.lines.join('\n')
            expect(shown).toContain('TAIL-OVER-TWO-MEG')
            expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(TEST_LIMITS.fileBytes)
        }
    })
})
