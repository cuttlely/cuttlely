import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'

// ---------- mocks (must be hoisted) ----------
const mockExistsSync = jest.fn()
const mockMkdirSync = jest.fn()

jest.mock('fs', () => ({
    existsSync: (...args: any[]) => mockExistsSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args)
}))

jest.mock('@cuttlely/components', () => {
    const winston = require('winston')
    return {
        StorageProviderFactory: {
            getProvider: jest.fn(() => ({
                getLoggerTransports: jest.fn(() => [new winston.transports.Console()])
            }))
        }
    }
})

jest.mock('../../src/utils/config', () => ({
    __esModule: true,
    default: {
        logging: { dir: '/tmp/flowise-test-logs' }
    }
}))

// ---------- load logger only after mocks (so our mocks are used) ----------
let logger: any
let expressRequestLogger: (req: any, res: any, next: any) => void
let auditLogger: any
let redactLoggedUrl: (url: string) => string

const ORIGINAL_ENV = process.env

describe('logger.ts', () => {
    beforeAll(() => {
        mockExistsSync.mockReturnValue(false) // so line 22 (mkdirSync) runs when module loads
        jest.resetModules()
        const mod = require('../../src/utils/logger')
        logger = mod.default
        expressRequestLogger = mod.expressRequestLogger
        auditLogger = mod.auditLogger
        redactLoggedUrl = mod.redactLoggedUrl
        // Assert here so beforeEach's clearAllMocks() doesn't wipe call history
        expect(mockExistsSync).toHaveBeenCalled()
        expect(mockMkdirSync).toHaveBeenCalled()
    })

    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV }
        jest.clearAllMocks()
    })

    afterEach(() => {
        process.env = ORIGINAL_ENV
    })

    describe('expressRequestLogger', () => {
        const next = jest.fn()

        it('calls next()', () => {
            const req = { url: '/api/v1/chatflows', method: 'GET', params: {} } as any
            expressRequestLogger(req, {} as any, next)
            expect(next).toHaveBeenCalled()
        })

        it('does not log when URL is in unwantedLogURLs (ping)', () => {
            const req = { url: '/api/v1/ping', method: 'GET', params: {} } as any
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
            expressRequestLogger(req, {} as any, next)
            expect(next).toHaveBeenCalled()
            expect(infoSpy).not.toHaveBeenCalled()
            infoSpy.mockRestore()
        })

        it('does not log when URL is in unwantedLogURLs (node-icon)', () => {
            const req = { url: '/api/v1/node-icon/xyz', method: 'GET', params: {} } as any
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
            expressRequestLogger(req, {} as any, next)
            expect(next).toHaveBeenCalled()
            expect(infoSpy).not.toHaveBeenCalled()
            infoSpy.mockRestore()
        })

        it('does not log when URL does not match /api/v1/', () => {
            const req = { url: '/health', method: 'GET', params: {} } as any
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
            expressRequestLogger(req, {} as any, next)
            expect(next).toHaveBeenCalled()
            expect(infoSpy).not.toHaveBeenCalled()
            infoSpy.mockRestore()
        })

        it('does not write an API key from the chatflows or verify path', () => {
            const secret = 'super-secret-bearer-token'
            const chatflows = redactLoggedUrl(`/api/v1/chatflows/apikey/${secret}?keyonly=1`)
            const verify = redactLoggedUrl(`/api/v1/verify/apikey/${secret}`)
            expect(chatflows).toBe('/api/v1/chatflows/apikey/[redacted]?keyonly=1')
            expect(verify).toBe('/api/v1/verify/apikey/[redacted]')
            expect(chatflows).not.toContain(secret)
            expect(verify).not.toContain(secret)
        })

        it('logs GET request (requestLogger.http path)', () => {
            const req = { url: '/api/v1/chatflows', method: 'GET', params: {} } as any
            expressRequestLogger(req, {} as any, next)
            expect(next).toHaveBeenCalled()
        })

        it('does not write a question search on the check history request line', () => {
            const secret = 'do-you-have-rye-loaves'
            const logged = redactLoggedUrl(`/api/v1/flow-drafts/flow-1/check/history?limit=50&q=${secret}&source=chat`)
            expect(logged).toBe('/api/v1/flow-drafts/flow-1/check/history?limit=50&q=[redacted]&source=chat')
            expect(logged).not.toContain(secret)
        })

        it('does not write a question search or page cursor in the debug query record', () => {
            process.env.DEBUG = 'true'
            const search = 'do-you-have-rye-loaves'
            const token = 'signed-page-cursor-token'
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
            const req = {
                url: `/api/v1/flow-drafts/flow-1/check/history?limit=50&q=${search}&cursor=${token}`,
                method: 'POST',
                params: {},
                body: {},
                query: { limit: '50', q: search, cursor: token, Cursor: token },
                headers: {}
            } as any
            expressRequestLogger(req, {} as any, next)
            const logged = JSON.stringify(infoSpy.mock.calls)
            expect(logged).not.toContain(search)
            expect(logged).not.toContain(token)
            const meta = infoSpy.mock.calls[0][1] as { request: { query: Record<string, string>; url: string } }
            expect(meta.request.query).toEqual({ limit: '50', q: '[redacted]', cursor: '[redacted]', Cursor: '[redacted]' })
            expect(meta.request.url).not.toContain(search)
            expect(meta.request.url).not.toContain(token)
            infoSpy.mockRestore()
        })

        it('masks an email-like query value and finishes a long repeated string', () => {
            process.env.DEBUG = 'true'
            const repeated = 'a'.repeat(20000)
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
            const started = Date.now()
            const req = {
                url: '/api/v1/chatflows',
                method: 'POST',
                params: {},
                body: {},
                query: {
                    note: `${repeated}@${repeated}.com`,
                    local: `${'a'.repeat(200)}@${'b'.repeat(200)}.com`,
                    remark: 'see jane@bakery.example today',
                    pair: 'a@b.co and c@d.co'
                },
                headers: {}
            } as any
            expressRequestLogger(req, {} as any, next)
            expect(Date.now() - started).toBeLessThan(1000)
            const query = (infoSpy.mock.calls[0][1] as { request: { query: Record<string, string> } }).request.query
            expect(query.note).toBe('**********')
            expect(query.local).toBe('**********')
            expect(query.remark).toBe('see ********** today')
            expect(query.pair).toBe('********** and **********')
            const logged = JSON.stringify(infoSpy.mock.calls)
            expect(logged).not.toContain(repeated.slice(0, 40))
            expect(logged).not.toContain('jane@bakery.example')
            infoSpy.mockRestore()
        })

        it('redacts bracketed search and cursor keys in the debug query record', () => {
            process.env.DEBUG = 'true'
            const search = 'do-you-have-rye-loaves'
            const token = 'signed-page-cursor-token'
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
            const req = {
                url: '/api/v1/flow-drafts/flow-1/check/history?limit=50',
                method: 'POST',
                params: {},
                body: {},
                query: {
                    limit: '50',
                    'q[]': search,
                    'q[0]': search,
                    'cursor[]': token,
                    'cursor[0]': token,
                    '%71': search,
                    'q%5B0%5D': search
                },
                headers: {}
            } as any
            expressRequestLogger(req, {} as any, next)
            const logged = JSON.stringify(infoSpy.mock.calls)
            expect(logged).not.toContain(search)
            expect(logged).not.toContain(token)
            const query = (infoSpy.mock.calls[0][1] as { request: { query: Record<string, string> } }).request.query
            expect(query.limit).toBe('50')
            expect(query['q[]']).toBe('[redacted]')
            expect(query['q[0]']).toBe('[redacted]')
            expect(query['cursor[]']).toBe('[redacted]')
            expect(query['cursor[0]']).toBe('[redacted]')
            expect(query['%71']).toBe('[redacted]')
            expect(query['q%5B0%5D']).toBe('[redacted]')
            infoSpy.mockRestore()
        })

        it('does not write a search or cursor under a bracketed or encoded name', () => {
            const search = 'do-you-have-rye-loaves'
            const token = 'signed-page-cursor-token'
            const cases = [
                [`q[]=${search}`, 'q[]=[redacted]'],
                [`q[0]=${search}`, 'q[0]=[redacted]'],
                [`%71=${search}`, '%71=[redacted]'],
                [`q%5B0%5D=${search}`, 'q%5B0%5D=[redacted]'],
                [`cursor[]=${token}`, 'cursor[]=[redacted]'],
                [`cursor[0]=${token}`, 'cursor[0]=[redacted]'],
                [`%63ursor=${token}`, '%63ursor=[redacted]'],
                [`cursor%5B%5D=${token}`, 'cursor%5B%5D=[redacted]']
            ]
            for (const [form, expected] of cases) {
                const logged = redactLoggedUrl(`/api/v1/flow-drafts/flow-1/check/history?limit=1&${form}&source=chat`)
                expect(logged).toBe(`/api/v1/flow-drafts/flow-1/check/history?limit=1&${expected}&source=chat`)
                expect(logged).not.toContain(search)
                expect(logged).not.toContain(token)
            }
        })

        it('does not write a history page cursor on the request line', () => {
            const token = 'signed-page-cursor-token'
            const logged = redactLoggedUrl(`/api/v1/flow-drafts/flow-1/check/history?cursor=${token}&limit=1`)
            expect(logged).toBe('/api/v1/flow-drafts/flow-1/check/history?cursor=[redacted]&limit=1')
            expect(logged).not.toContain(token)
            const later = redactLoggedUrl(`/api/v1/flow-drafts/flow-1/check/history?limit=1&Cursor=${token}`)
            expect(later).not.toContain(token)
            expect(later).toContain('Cursor=[redacted]')
        })

        it('does not write a client session id or session token on the request line', () => {
            process.env.DEBUG = 'true'
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
            const req = {
                url: '/api/v1/prediction/flow?chatId=victim-session&sessionToken=sekret-token',
                method: 'POST',
                params: {},
                body: {
                    chatId: 'victim-session',
                    sessionToken: 'sekret-token',
                    overrideConfig: { sessionId: 'victim-session' }
                },
                query: { chatId: 'victim-session', sessionId: 'victim-session' },
                headers: { 'x-cuttlely-session-token': 'sekret-token' }
            } as any
            expressRequestLogger(req, {} as any, next)
            const logged = JSON.stringify(infoSpy.mock.calls)
            expect(logged).not.toContain('victim-session')
            expect(logged).not.toContain('sekret-token')
            expect(logged).toContain('[redacted]')
            infoSpy.mockRestore()
        })

        it('does not write the GitHub token from a connect request body', () => {
            process.env.DEBUG = 'true'
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
            const req = {
                url: '/api/v1/flow-versions/github',
                method: 'PUT',
                params: {},
                body: { repo: 'acme/flows', token: 'test-token-NOT-REAL-7f3a9c' },
                query: {},
                headers: {}
            } as any
            expressRequestLogger(req, {} as any, next)
            expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('test-token-NOT-REAL')
            infoSpy.mockRestore()
        })

        it('does not write a local password or the local session cookie on a debug line', () => {
            process.env.DEBUG = 'true'
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger)
            const password = 'Sup3r-Secret!'
            const nextPassword = 'An0ther-Secret!'
            const cookie = 'local-session-cookie-value'
            expressRequestLogger(
                {
                    url: '/api/v1/auth/local/login',
                    method: 'POST',
                    params: {},
                    body: { email: 'ada@example.com', Email: 'Ada@Localhost', profile: { email: 'nested@localhost' }, password },
                    query: {},
                    headers: { cookie: `cuttlely-local-session=${cookie}` }
                } as any,
                {} as any,
                next
            )
            expressRequestLogger(
                {
                    url: '/api/v1/auth/local/password',
                    method: 'POST',
                    params: {},
                    body: { currentPassword: password, newPassword: nextPassword },
                    query: {},
                    headers: { cookie: `other=1; cuttlely-local-session=${cookie}` }
                } as any,
                {} as any,
                next
            )
            const logged = JSON.stringify(infoSpy.mock.calls)
            expect(logged).not.toContain(password)
            expect(logged).not.toContain(nextPassword)
            expect(logged).not.toContain(cookie)
            expect(logged).not.toContain('ada@example.com')
            expect(logged).not.toContain('Ada@Localhost')
            expect(logged).not.toContain('nested@localhost')
            expect(logged).toContain('cuttlely-local-session=[redacted]')
            expect(logged).toContain('[redacted]')
            infoSpy.mockRestore()
        })

        it('logs POST request (requestLogger.info + logger.info path)', () => {
            const req = { url: '/api/v1/chatflows', method: 'POST', params: {} } as any
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
            expressRequestLogger(req, {} as any, next)
            expect(next).toHaveBeenCalled()
            expect(infoSpy).toHaveBeenCalled()
            infoSpy.mockRestore()
        })

        it('logs PUT request', () => {
            const req = { url: '/api/v1/chatflows/1', method: 'PUT', params: {} } as any
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
            expressRequestLogger(req, {} as any, next)
            expect(infoSpy).toHaveBeenCalled()
            infoSpy.mockRestore()
        })

        it('does not log a rejected server-settings body', () => {
            process.env.DEBUG = 'true'
            const secret = 'fake-langsmith-key-b3'
            const redis = 'redis://fake-user:fake-pass-b3@example.invalid:6399/0'
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
            const auditSpy = jest.spyOn(auditLogger, 'info').mockImplementation(() => {})
            const req = {
                url: '/api/v1/server-settings/read-only/LANGSMITH_API_KEY',
                method: 'PUT',
                params: { key: 'LANGSMITH_API_KEY' },
                body: { value: secret, redis },
                query: {},
                headers: {}
            } as any
            expressRequestLogger(req, {} as any, next)
            const logged = JSON.stringify(infoSpy.mock.calls) + JSON.stringify(auditSpy.mock.calls)
            expect(logged).toContain('[redacted]')
            expect(logged).not.toContain(secret)
            expect(logged).not.toContain('fake-pass-b3')
            expect(logged).not.toContain('example.invalid')
            infoSpy.mockRestore()
            auditSpy.mockRestore()
        })

        it('logs DELETE request', () => {
            const req = { url: '/api/v1/chatflows/1', method: 'DELETE', params: {} } as any
            const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
            expressRequestLogger(req, {} as any, next)
            expect(infoSpy).toHaveBeenCalled()
            infoSpy.mockRestore()
        })

        it('when DEBUG=true runs sanitization (getSensitiveBodyFields, getSensitiveHeaderFields, sanitizeObject)', () => {
            process.env.DEBUG = 'true'
            process.env.LOG_SANITIZE_BODY_FIELDS = 'password,secret'
            process.env.LOG_SANITIZE_HEADER_FIELDS = 'authorization'

            const req = {
                url: '/api/v1/chatflows',
                method: 'POST',
                params: {},
                body: { password: 'mypass', user: 'john@example.com' },
                query: { token: 'x@y.z' },
                headers: { authorization: 'Bearer xxx', 'content-type': 'application/json' }
            } as any
            const res = {} as any

            expressRequestLogger(req, res, next)
            expect(next).toHaveBeenCalled()
        })

        it('when DEBUG=true and no sanitize env vars still includes body/query/headers', () => {
            process.env.DEBUG = 'true'
            delete process.env.LOG_SANITIZE_BODY_FIELDS
            delete process.env.LOG_SANITIZE_HEADER_FIELDS

            const req = {
                url: '/api/v1/chatflows',
                method: 'POST',
                params: {},
                body: { foo: 1 },
                query: {},
                headers: {}
            } as any

            expressRequestLogger(req, {} as any, next)
            expect(next).toHaveBeenCalled()
        })
    })

    describe('exports', () => {
        it('default logger has log methods', () => {
            expect(logger.info).toBeDefined()
            expect(logger.error).toBeDefined()
            expect(logger.warn).toBeDefined()
            expect(logger.debug).toBeDefined()
        })

        it('auditLogger is defined', () => {
            expect(auditLogger).toBeDefined()
            expect(typeof auditLogger.log).toBe('function')
        })
    })
})
