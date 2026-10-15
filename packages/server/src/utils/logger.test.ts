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
