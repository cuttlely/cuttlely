/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
let mockCachedMethod: 'workos' | 'oidc' = 'workos'
const mockRefreshAuthenticationView = jest.fn(async () => {
    mockCachedMethod = 'oidc'
})
const mockOidcInviteStartUrl = jest.fn(async () => ({ url: 'https://id.example/authorize', browserNonce: 'browser-nonce' }))
const mockHandleInviteStart = jest.fn(async () => ({ type: 'json', status: 404, body: { message: 'Not Found' } }))

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), verbose: jest.fn() }
}))
jest.mock('./production', () => ({
    buildAuthContext: jest.fn(),
    refreshAuthenticationView: mockRefreshAuthenticationView
}))
jest.mock('./authenticationState', () => ({
    selectedAuthenticationMethod: () => mockCachedMethod
}))
jest.mock('./oidcRoutes', () => ({
    oidcCallbackUrl: () => 'https://app.example/api/v1/auth/oidc/callback',
    oidcInviteStartUrl: mockOidcInviteStartUrl
}))
jest.mock('./handlers', () => {
    const actual = jest.requireActual('./handlers')
    return { ...actual, handleInviteStart: mockHandleInviteStart }
})

import { identityAuthRouter } from './http'

function inviteStartHandler(): (req: unknown, res: unknown, next: (error?: unknown) => void) => void {
    const layer = (
        identityAuthRouter as unknown as { stack: Array<{ route?: { path?: string; stack?: Array<{ handle: unknown }> } }> }
    ).stack.find((candidate) => candidate.route?.path === '/invite/start')
    return layer?.route?.stack?.[0]?.handle as (req: unknown, res: unknown, next: (error?: unknown) => void) => void
}

describe('active authentication method route dispatch', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCachedMethod = 'workos'
    })

    it('refreshes a second process before dispatching an invitation after OIDC activation', async () => {
        const response = await new Promise<{ status: number; body: unknown; cookies: string[] }>((resolve, reject) => {
            let status = 200
            const cookies: string[] = []
            const res = {
                headersSent: false,
                cookie(name: string) {
                    cookies.push(name)
                    return this
                },
                status(code: number) {
                    status = code
                    return this
                },
                json(body: unknown) {
                    resolve({ status, body, cookies })
                    return this
                }
            }
            inviteStartHandler()(
                {
                    headers: { 'x-request-from': 'internal' },
                    body: { token: 'invitation-token' },
                    secure: false,
                    protocol: 'https'
                },
                res,
                reject
            )
        })

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ url: 'https://id.example/authorize' })
        expect(response.cookies).toEqual(['cuttlely-oidc-browser'])
        expect(mockRefreshAuthenticationView).toHaveBeenCalledTimes(1)
        expect(mockOidcInviteStartUrl).toHaveBeenCalledWith(expect.anything(), 'invitation-token')
        expect(mockHandleInviteStart).not.toHaveBeenCalled()
    })
})
