import { secureAxiosRequest } from './httpSecurity'
import { OAUTH2_REFRESH_FAILED, refreshStoredOAuth2Credential } from './oauthRefresh'

jest.mock('./httpSecurity', () => ({
    secureAxiosRequest: jest.fn()
}))

const mockSecureAxiosRequest = secureAxiosRequest as jest.Mock

const decrypted = {
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    refresh_token: 'refresh-secret-value',
    accessTokenUrl: 'https://oauth2.googleapis.com/token',
    access_token: 'old-access-token'
}

const providerSecret = 'provider-body-secret-do-not-echo'

function storeFor(
    credential: { id: string; workspaceId: string } | null,
    shares = 0
): {
    appDataSource: any
    update: jest.Mock
    findOneBy: jest.Mock
    count: jest.Mock
} {
    const update = jest.fn().mockResolvedValue(undefined)
    const findOneBy = jest.fn().mockResolvedValue(credential)
    const count = jest.fn().mockResolvedValue(shares)
    const appDataSource = {
        getRepository: jest.fn((entity: { kind?: string }) => {
            if (entity && entity.kind === 'share') return { findOneBy, update, count }
            return { findOneBy, update, count }
        }),
        entityMetadatas: [{ name: 'WorkspaceShared', target: { kind: 'share' } }]
    }
    return { appDataSource, update, findOneBy, count }
}

describe('refreshStoredOAuth2Credential', () => {
    let errorLog: jest.SpyInstance

    beforeEach(() => {
        jest.clearAllMocks()
        errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        errorLog.mockRestore()
    })

    it('stores the new token and does not put the provider body on the thrown error', async () => {
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: {
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                token_type: 'Bearer',
                expires_in: 3600,
                extra_secret: providerSecret
            }
        })
        const { appDataSource, update } = storeFor({ id: 'cred-1', workspaceId: 'ws-1' })
        const encrypt = jest.fn().mockResolvedValue('encrypted')

        const updated = await refreshStoredOAuth2Credential({
            credentialId: 'cred-1',
            credentialData: decrypted,
            appDataSource,
            credentialEntity: { kind: 'credential' },
            workspaceId: 'ws-1',
            encrypt
        })

        expect(updated.access_token).toBe('new-access-token')
        expect(updated.extra_secret).toBeUndefined()
        expect(encrypt).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'new-access-token' }))
        expect(update).toHaveBeenCalledWith('cred-1', expect.objectContaining({ encryptedData: 'encrypted' }))
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain(providerSecret)
    })

    it('throws a generic error when the provider body contains a secret', async () => {
        mockSecureAxiosRequest.mockResolvedValue({
            status: 400,
            data: {
                error: 'invalid_grant',
                error_description: providerSecret,
                access_token: 'leaked-access-token'
            }
        })
        const { appDataSource, update } = storeFor({ id: 'cred-1', workspaceId: 'ws-1' })

        await expect(
            refreshStoredOAuth2Credential({
                credentialId: 'cred-1',
                credentialData: decrypted,
                appDataSource,
                credentialEntity: { kind: 'credential' },
                workspaceId: 'ws-1',
                encrypt: jest.fn()
            })
        ).rejects.toThrow(OAUTH2_REFRESH_FAILED)

        expect(update).not.toHaveBeenCalled()
        const logged = JSON.stringify(errorLog.mock.calls)
        expect(logged).toContain('invalid_grant')
        expect(logged).not.toContain(providerSecret)
        expect(logged).not.toContain('leaked-access-token')
        expect(logged).not.toContain('client-secret-value')
        expect(logged).not.toContain('refresh-secret-value')
    })

    it('does not call the provider for a credential in another workspace', async () => {
        const { appDataSource, count } = storeFor({ id: 'cred-1', workspaceId: 'ws-other' }, 0)

        await expect(
            refreshStoredOAuth2Credential({
                credentialId: 'cred-1',
                credentialData: decrypted,
                appDataSource,
                credentialEntity: { kind: 'credential' },
                workspaceId: 'ws-1',
                encrypt: jest.fn()
            })
        ).rejects.toThrow(OAUTH2_REFRESH_FAILED)

        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(count).toHaveBeenCalled()
    })

    it('refreshes a credential shared into the caller workspace', async () => {
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: { access_token: 'shared-access', token_type: 'Bearer', expires_in: 60 }
        })
        const { appDataSource } = storeFor({ id: 'cred-1', workspaceId: 'ws-owner' }, 1)

        const updated = await refreshStoredOAuth2Credential({
            credentialId: 'cred-1',
            credentialData: decrypted,
            appDataSource,
            credentialEntity: { kind: 'credential' },
            workspaceId: 'ws-1',
            encrypt: jest.fn().mockResolvedValue('encrypted')
        })

        expect(updated.access_token).toBe('shared-access')
        expect(mockSecureAxiosRequest).toHaveBeenCalled()
    })

    it('does not call the public refresh URL when the node has no database', async () => {
        await expect(
            refreshStoredOAuth2Credential({
                credentialId: 'cred-1',
                credentialData: decrypted,
                encrypt: jest.fn()
            })
        ).rejects.toThrow(OAUTH2_REFRESH_FAILED)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
    })
})
