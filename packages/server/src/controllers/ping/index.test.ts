import fs from 'fs'
import os from 'os'
import path from 'path'
import { backgroundBootPass, beginBootPass, finishBootPass, markBootIncomplete, resetBootPass } from '../../services/harnesses/bootGate'
import { composePing, pingForDataDir } from './index'

describe('ping hermes health', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-ping-'))
    const file = path.join(dir, 'hermes-supervisor.json')

    afterEach(() => resetBootPass())

    afterAll(() => {
        resetBootPass()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('stays pong when the supervisor has not written a status', () => {
        expect(pingForDataDir(undefined)).toEqual({ code: 200, body: 'pong', header: 'unknown', analyst: 'unknown' })
        expect(pingForDataDir(dir)).toEqual({ code: 200, body: 'pong', header: 'unknown', analyst: 'unknown' })
    })

    it('stays pong while Hermes is up or restarting', () => {
        fs.writeFileSync(file, `${JSON.stringify({ state: 'up', restarts: 0, pid: 1, detail: '' })}\n`)
        expect(pingForDataDir(dir).code).toBe(200)
        expect(pingForDataDir(dir).header).toBe('up')
        fs.writeFileSync(file, `${JSON.stringify({ state: 'restarting', restarts: 1, pid: 0, detail: 'exit 75' })}\n`)
        expect(pingForDataDir(dir)).toMatchObject({ code: 200, body: 'pong', header: 'restarting' })
        fs.writeFileSync(file, `${JSON.stringify({ state: 'degraded', restarts: 0, pid: 1, detail: 'health' })}\n`)
        expect(pingForDataDir(dir)).toMatchObject({ code: 200, body: 'pong', header: 'degraded' })
    })

    it('reports hermes down after the restart limit', () => {
        fs.writeFileSync(file, `${JSON.stringify({ state: 'down', restarts: 6, pid: 0, detail: 'exit 75' })}\n`)
        expect(pingForDataDir(dir)).toEqual({ code: 503, body: 'hermes down', header: 'down', analyst: 'unknown' })
    })

    it('answers 503 until the boot profile compile finishes, then 200', () => {
        beginBootPass()
        expect(composePing(dir)).toEqual({
            code: 503,
            body: 'profiles compiling',
            header: 'compiling',
            analyst: 'unknown',
            retryAfter: 30
        })
        fs.writeFileSync(file, `${JSON.stringify({ state: 'up', restarts: 0, pid: 1, detail: '' })}\n`)
        expect(composePing(dir).code).toBe(503)
        finishBootPass()
        expect(composePing(dir)).toMatchObject({ code: 200, body: 'pong', header: 'up' })
        expect(composePing(dir).retryAfter).toBeUndefined()
    })

    it('stays 503 when the boot compile did not finish, and answers 200 while a long compile runs in the background', () => {
        markBootIncomplete()
        expect(composePing(undefined)).toMatchObject({ code: 503, body: 'profiles compiling', retryAfter: 30 })
        resetBootPass()
        beginBootPass()
        backgroundBootPass()
        expect(composePing(dir)).toMatchObject({ code: 200, body: 'pong' })
    })

    it('says when the analyst tool is missing', () => {
        fs.writeFileSync(path.join(dir, 'analyst-mcp.json'), `${JSON.stringify({ tools: 0 })}\n`)
        expect(pingForDataDir(dir).analyst).toBe('missing')
        fs.writeFileSync(path.join(dir, 'analyst-mcp.json'), `${JSON.stringify({ tools: 1 })}\n`)
        expect(pingForDataDir(dir).analyst).toBe('ready')
    })
})
