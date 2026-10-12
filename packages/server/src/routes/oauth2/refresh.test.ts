import axios from 'axios'
import express, { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import request from 'supertest'
import { secureAxiosRequest } from '@cuttlely/components'
import { setTeamPermissionLookup } from '../../identity/rbac'
import errorHandlerMiddleware from '../../middlewares/errors'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from '../../utils/constants'
import { decryptCredentialData, encryptCredentialData } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import oauth2Router from './index'

jest.mock('@cuttlely/components', () => ({
    secureAxiosRequest: jest.fn()
}))

jest.mock('../../utils', () => ({
    decryptCredentialData: jest.fn(),
    encryptCredentialData: jest.fn()
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))

const mockSecureAxiosRequest = secureAxiosRequest as jest.Mock
const mockDecrypt = decryptCredentialData as jest.Mock
const mockEncrypt = encryptCredentialData as jest.Mock
const mockGetApp = getRunningExpressApp as jest.Mock
const mockLogError = logger.error as jest.Mock

const providerSecret = 'provider-body-secret-do-not-echo'
const accessToken = 'access-token-do-not-return'
const refreshToken = 'refresh-token-do-not-return'

const decrypted = {
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    refresh_token: 'stored-refresh-token',
    accessTokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'email'
}

const apiKeyUser = {
    permissions: ['credentials:update'],
    activeWorkspaceId: 'ws-1',
    activeOrganizationId: 'org-1',
    isOrganizationAdmin: false
}

function appFor(user: object | null) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        next()
    })
    app.use('/api/v1/oauth2-credential', oauth2Router)
    app.use(errorHandlerMiddleware)
    return request(app)
}

describe('POST /api/v1/oauth2-credential/refresh/:credentialId', () => {
    const findOneBy = jest.fn()
    const update = jest.fn()
    const shareFindOneBy = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        setTeamPermissionLookup(null)
        findOneBy.mockResolvedValue(null)
        update.mockResolvedValue(undefined)
        shareFindOneBy.mockResolvedValue(null)
        mockDecrypt.mockResolvedValue(decrypted)
        mockEncrypt.mockResolvedValue('encrypted')
        mockGetApp.mockReturnValue({
            AppDataSource: {
                getRepository: (entity: { name?: string }) => {
                    if (entity?.name === 'WorkspaceShared') return { findOneBy: shareFindOneBy }
                    return { findOneBy, update }
                }
            }
        })
    })

    afterEach(() => {
        setTeamPermissionLookup(null)
    })

    it('keeps the browser callback public and does not whitelist refresh or authorize', () => {
        expect(WHITELIST_URLS).toContain('/api/v1/oauth2-credential/callback')
        expect(WHITELIST_URLS).not.toContain('/api/v1/oauth2-credential/refresh')
        const refreshPath = '/api/v1/oauth2-credential/refresh/cred-1'
        const authorizePath = '/api/v1/oauth2-credential/authorize/cred-1'
        const callbackPath = '/api/v1/oauth2-credential/callback'
        expect(WHITELIST_URLS.some((url) => refreshPath.startsWith(url))).toBe(false)
        expect(WHITELIST_URLS.some((url) => authorizePath.startsWith(url))).toBe(false)
        expect(WHITELIST_URLS.some((url) => callbackPath.startsWith(url))).toBe(true)
    })

    it('requires the same sign-in for the node list and the pack index', () => {
        // An unauthenticated /api/v1 request that is not on the public list gets 401,
        // whether the API-key list refuses it or the key is missing. Both node routes take that path.
        const status = (path: string) => {
            if (WHITELIST_URLS.some((url) => path.startsWith(url))) return 200
            if (API_KEY_BLACKLIST_URLS.some((url) => path.startsWith(url))) return 401
            return 401
        }
        expect(status('/api/v1/nodes/pack-index')).toBe(status('/api/v1/nodes'))
        expect(status('/api/v1/nodes')).toBe(401)
    })

    it('returns 401 when the caller is not authenticated', async () => {
        const res = await appFor(null).post('/api/v1/oauth2-credential/refresh/cred-1')
        expect(res.status).toBe(StatusCodes.UNAUTHORIZED)
        expect(findOneBy).not.toHaveBeenCalled()
        expect(mockDecrypt).not.toHaveBeenCalled()
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
    })

    it('returns 403 when the caller cannot update credentials', async () => {
        const res = await appFor({ ...apiKeyUser, permissions: ['credentials:view'] }).post('/api/v1/oauth2-credential/refresh/cred-1')
        expect(res.status).toBe(StatusCodes.FORBIDDEN)
        expect(findOneBy).not.toHaveBeenCalled()
        expect(mockDecrypt).not.toHaveBeenCalled()
    })

    it('returns 404 for a credential in another workspace and does not decrypt it', async () => {
        findOneBy.mockImplementation(async (query: { id?: string; workspaceId?: string }) => {
            if (query.workspaceId === 'ws-1') return null
            if (query.id === 'cred-1') {
                return { id: 'cred-1', workspaceId: 'ws-other', encryptedData: 'foreign-ciphertext' }
            }
            return null
        })

        const res = await appFor(apiKeyUser).post('/api/v1/oauth2-credential/refresh/cred-1')

        expect(res.status).toBe(StatusCodes.NOT_FOUND)
        expect(res.body).toEqual({ success: false, message: 'Credential not found' })
        expect(mockDecrypt).not.toHaveBeenCalled()
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(update).not.toHaveBeenCalled()
    })

    it('returns a generic body when the provider response contains a secret', async () => {
        findOneBy.mockImplementation(async (query: { id?: string; workspaceId?: string }) => {
            if (query.id === 'cred-1' && query.workspaceId === 'ws-1') {
                return { id: 'cred-1', workspaceId: 'ws-1', encryptedData: 'ciphertext' }
            }
            return null
        })
        mockSecureAxiosRequest.mockResolvedValue({
            status: 400,
            statusText: 'Bad Request',
            data: {
                error: 'invalid_grant',
                error_description: providerSecret,
                access_token: accessToken,
                refresh_token: refreshToken
            }
        })

        const res = await appFor(apiKeyUser).post('/api/v1/oauth2-credential/refresh/cred-1')

        expect(res.status).toBe(StatusCodes.BAD_GATEWAY)
        expect(res.body).toEqual({ success: false, message: 'Token refresh failed' })
        const wire = JSON.stringify(res.body)
        expect(wire).not.toContain(providerSecret)
        expect(wire).not.toContain(accessToken)
        expect(wire).not.toContain(refreshToken)
        expect(wire).not.toContain('invalid_grant')
        expect(wire).not.toContain('client-secret-value')
        expect(res.body.details).toBeUndefined()
        expect(update).not.toHaveBeenCalled()
        const logged = JSON.stringify(mockLogError.mock.calls)
        expect(logged).toContain('invalid_grant')
        expect(logged).not.toContain(providerSecret)
        expect(logged).not.toContain(accessToken)
        expect(logged).not.toContain('client-secret-value')
    })

    it('hides an axios provider body', async () => {
        findOneBy.mockResolvedValue({ id: 'cred-1', workspaceId: 'ws-1', encryptedData: 'ciphertext' })
        const error = new axios.AxiosError('request failed')
        error.response = {
            data: { error_description: providerSecret, access_token: accessToken },
            status: 400,
            statusText: 'Bad Request',
            headers: {},
            config: { headers: {} as never }
        }
        mockSecureAxiosRequest.mockRejectedValue(error)

        const res = await appFor(apiKeyUser).post('/api/v1/oauth2-credential/refresh/cred-1')

        expect(res.status).toBe(StatusCodes.BAD_GATEWAY)
        expect(res.body).toEqual({ success: false, message: 'Token refresh failed' })
        expect(JSON.stringify(res.body)).not.toContain(providerSecret)
        expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(providerSecret)
    })

    it('refreshes a credential in the caller workspace without returning the access token', async () => {
        findOneBy.mockImplementation(async (query: { id?: string; workspaceId?: string }) => {
            if (query.id === 'cred-1' && query.workspaceId === 'ws-1') {
                return { id: 'cred-1', workspaceId: 'ws-1', encryptedData: 'ciphertext' }
            }
            return null
        })
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: {
                access_token: accessToken,
                refresh_token: refreshToken,
                token_type: 'Bearer',
                expires_in: 3600,
                extra_field: providerSecret
            }
        })

        const res = await appFor(apiKeyUser).post('/api/v1/oauth2-credential/refresh/cred-1')

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.credentialId).toBe('cred-1')
        expect(res.body.tokenInfo).toEqual({
            token_type: 'Bearer',
            has_new_refresh_token: true,
            expires_at: expect.any(String)
        })
        expect(Object.keys(res.body).sort()).toEqual(['credentialId', 'message', 'success', 'tokenInfo'])
        expect(Object.keys(res.body.tokenInfo).sort()).toEqual(['expires_at', 'has_new_refresh_token', 'token_type'])
        const wire = JSON.stringify(res.body)
        expect(wire).not.toContain(accessToken)
        expect(wire).not.toContain(refreshToken)
        expect(wire).not.toContain(providerSecret)
        expect(wire).not.toContain('client-secret-value')
        expect(mockEncrypt).toHaveBeenCalledWith(expect.objectContaining({ access_token: accessToken }))
        expect(update).toHaveBeenCalledWith('cred-1', expect.objectContaining({ encryptedData: 'encrypted' }))
        expect(mockDecrypt.mock.invocationCallOrder[0]).toBeLessThan(mockSecureAxiosRequest.mock.invocationCallOrder[0])
    })

    it('refreshes a credential shared into the caller workspace', async () => {
        findOneBy.mockImplementation(async (query: { id?: string; workspaceId?: string }) => {
            if (query.workspaceId) return null
            if (query.id === 'cred-1') return { id: 'cred-1', workspaceId: 'ws-owner', encryptedData: 'ciphertext' }
            return null
        })
        shareFindOneBy.mockResolvedValue({ id: 'share-1' })
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: { access_token: accessToken, token_type: 'Bearer', expires_in: 60 }
        })

        const res = await appFor(apiKeyUser).post('/api/v1/oauth2-credential/refresh/cred-1')

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(JSON.stringify(res.body)).not.toContain(accessToken)
        expect(shareFindOneBy).toHaveBeenCalledWith({
            workspaceId: 'ws-1',
            sharedItemId: 'cred-1',
            itemType: 'credential'
        })
    })

    it('accepts a signed-in session with the credential update permission', async () => {
        setTeamPermissionLookup({
            accessFor: async () => ({ owner: false, permissions: ['credentials:create'] })
        })
        findOneBy.mockResolvedValue({ id: 'cred-1', workspaceId: 'ws-1', encryptedData: 'ciphertext' })
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: { access_token: accessToken, token_type: 'Bearer', expires_in: 60 }
        })

        const res = await appFor({
            id: 'user-1',
            activeWorkspaceId: 'ws-1',
            activeOrganizationId: 'org-1',
            isOrganizationAdmin: false
        }).post('/api/v1/oauth2-credential/refresh/cred-1')

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(JSON.stringify(res.body)).not.toContain(accessToken)
    })

    it('does not return an internal exception message', async () => {
        findOneBy.mockResolvedValue({ id: 'cred-1', workspaceId: 'ws-1', encryptedData: 'ciphertext' })
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: { access_token: accessToken, token_type: 'Bearer', expires_in: 10 }
        })
        mockEncrypt.mockRejectedValue(new Error(`disk failure ${providerSecret}`))

        const res = await appFor(apiKeyUser).post('/api/v1/oauth2-credential/refresh/cred-1')

        expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR)
        expect(res.body.message).toBe('Token refresh failed')
        expect(JSON.stringify(res.body)).not.toContain(providerSecret)
        expect(JSON.stringify(res.body)).not.toContain(accessToken)
    })
})
