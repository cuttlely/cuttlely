import { Request, Response } from 'express'
import { ExternalAgentError, externalAgentAuth, refuseKeylessFlow } from './externalAgentAuth'

const mockRes = () => {
    const res: Partial<Response> & { locals: Record<string, unknown> } = { locals: {} }
    return res as Response
}

const next = () => {
    const fn = jest.fn()
    return fn
}

describe('externalAgentAuth', () => {
    it('copies X-API-Key onto Authorization and moves the body', () => {
        const req = {
            headers: { 'x-api-key': 'k1' },
            body: { model: 'm', messages: [] }
        } as unknown as Request
        const nxt = next()
        externalAgentAuth(req, mockRes(), nxt)
        expect(req.headers.authorization).toBe('Bearer k1')
        expect((req as Request & { orchestrate?: unknown }).orchestrate).toEqual({ model: 'm', messages: [] })
        expect(req.body).toEqual({})
        expect(nxt).toHaveBeenCalledWith()
    })

    it('lets equal Bearer and X-API-Key headers through', () => {
        const req = { headers: { authorization: 'Bearer k1', 'x-api-key': 'k1' }, body: { a: 1 } } as unknown as Request
        const nxt = next()
        externalAgentAuth(req, mockRes(), nxt)
        expect(nxt.mock.calls[0][0]).toBeUndefined()
        expect(req.body).toEqual({})
    })

    it('answers 400 when the two keys differ, including different lengths', () => {
        const nxt = next()
        externalAgentAuth({ headers: { authorization: 'Bearer aaa', 'x-api-key': 'bbb' }, body: {} } as unknown as Request, mockRes(), nxt)
        expect(nxt.mock.calls[0][0]).toMatchObject({ statusCode: 400, code: 'credentials_conflict' })
        const nxt2 = next()
        externalAgentAuth(
            { headers: { authorization: 'Bearer short', 'x-api-key': 'much-longer-key' }, body: {} } as unknown as Request,
            mockRes(),
            nxt2
        )
        expect(nxt2.mock.calls[0][0]).toBeInstanceOf(ExternalAgentError)
        expect(nxt2.mock.calls[0][0].code).toBe('credentials_conflict')
    })

    it('answers 401 when Authorization is not a Bearer prefix', () => {
        const nxt = next()
        externalAgentAuth({ headers: { authorization: 'k1' }, body: {} } as unknown as Request, mockRes(), nxt)
        expect(nxt.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'unauthorized' })
        const nxt2 = next()
        externalAgentAuth({ headers: { authorization: 'Basic k1' }, body: {} } as unknown as Request, mockRes(), nxt2)
        expect(nxt2.mock.calls[0][0].statusCode).toBe(401)
    })
})

describe('refuseKeylessFlow', () => {
    const originalEnv = process.env

    afterEach(() => {
        process.env = { ...originalEnv }
    })

    it('lets a keyed flow through and refuses a keyless one', () => {
        const ok = next()
        refuseKeylessFlow({} as Request, { locals: { chatflow: { apikeyid: 'k' } } } as unknown as Response, ok)
        expect(ok).toHaveBeenCalledWith()
        const nxt = next()
        refuseKeylessFlow({} as Request, { locals: { chatflow: { apikeyid: '' } } } as unknown as Response, nxt)
        expect(nxt.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: 'keyless_flow' })
    })

    it('lifts the refusal only when the flag is set and it is not production', () => {
        process.env.CUTTLELY_ORCHESTRATE_ALLOW_KEYLESS = 'true'
        process.env.NODE_ENV = 'test'
        const ok = next()
        refuseKeylessFlow({} as Request, { locals: { chatflow: { id: 'f' } } } as unknown as Response, ok)
        expect(ok).toHaveBeenCalledWith()
        process.env.NODE_ENV = 'production'
        const nxt = next()
        refuseKeylessFlow({} as Request, { locals: { chatflow: { id: 'f' } } } as unknown as Response, nxt)
        expect(nxt.mock.calls[0][0].code).toBe('keyless_flow')
    })
})
