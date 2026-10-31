import {
    compareKeys,
    decideStoredApiKeyAuth,
    generateAPIKey,
    generateSecretHash,
    isStoredApiKeyLookup,
    planApiKeyRewrite,
    storedApiKeyLookup
} from './apiKey'
import { Platform } from '../Interface'
import apikeyService, { ownerForCreatedApiKey } from '../services/apikey'
import { getRunningExpressApp } from './getRunningExpressApp'

jest.mock('./getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('./addChatflowsCount', () => ({ addChatflowsCount: jest.fn(async (keys: unknown) => keys) }))

describe('Api Key', () => {
    it('should be able to generate a new api key', () => {
        const apiKey = generateAPIKey()
        expect(typeof apiKey === 'string').toEqual(true)
    })

    describe('generateSecretHash', () => {
        it('should return a string in hash.salt format', () => {
            const apiKey = 'test-api-key'
            const stored = generateSecretHash(apiKey)
            expect(typeof stored).toBe('string')
            const parts = stored.split('.')
            expect(parts).toHaveLength(2)
            expect(parts[0]).toMatch(/^[0-9a-f]+$/)
            expect(parts[1]).toMatch(/^[0-9a-f]+$/)
        })

        it('should produce different hashes for the same key (different salt)', () => {
            const apiKey = 'test-api-key'
            const stored1 = generateSecretHash(apiKey)
            const stored2 = generateSecretHash(apiKey)
            expect(stored1).not.toBe(stored2)
            expect(compareKeys(stored1, apiKey)).toBe(true)
            expect(compareKeys(stored2, apiKey)).toBe(true)
        })
    })

    describe('compareKeys', () => {
        it('should return true when supplied key matches stored hash', () => {
            const apiKey = generateAPIKey()
            const storedKey = generateSecretHash(apiKey)
            expect(compareKeys(storedKey, apiKey)).toBe(true)
        })

        it('should return false when supplied key does not match stored hash', () => {
            const apiKey = generateAPIKey()
            const storedKey = generateSecretHash(apiKey)
            expect(compareKeys(storedKey, 'wrong-key')).toBe(false)
        })

        it('should return false for a malformed stored secret', () => {
            expect(compareKeys('not-a-secret', 'anything')).toBe(false)
            expect(compareKeys('zz.nothex', 'anything')).toBe(false)
            expect(compareKeys('', 'anything')).toBe(false)
        })
    })

    describe('stored lookup', () => {
        const plaintext = 'test-api-key'
        const secret = generateSecretHash(plaintext)
        const lookup = storedApiKeyLookup(plaintext)

        it('marks a digest so a second rewrite skips it', () => {
            expect(isStoredApiKeyLookup(lookup)).toBe(true)
            expect(planApiKeyRewrite(plaintext)).toEqual({ action: 'replace', lookup })
            expect(planApiKeyRewrite(lookup)).toEqual({ action: 'skip' })
            expect(planApiKeyRewrite('')).toEqual({ action: 'skip' })
            expect(planApiKeyRewrite('a'.repeat(64))).toEqual({
                action: 'replace',
                lookup: storedApiKeyLookup('a'.repeat(64))
            })
        })

        it('accepts a hashed row only when the scrypt secret matches the bearer', () => {
            const row = { id: '1', apiKey: lookup, apiSecret: secret }
            expect(decideStoredApiKeyAuth(row, plaintext, 'lookup')).toEqual({ status: 'accept' })
            expect(decideStoredApiKeyAuth(row, 'wrong-key', 'lookup')).toEqual({ status: 'reject' })
            expect(decideStoredApiKeyAuth(undefined, plaintext, 'lookup')).toEqual({ status: 'absent' })
        })

        it('rewrites a legacy plaintext row and rejects the stored digest', () => {
            const legacy = { id: '1', apiKey: plaintext, apiSecret: secret }
            expect(decideStoredApiKeyAuth(legacy, plaintext, 'legacy')).toEqual({ status: 'accept-rewrite', lookup })
            const broken = { id: '1', apiKey: plaintext, apiSecret: 'not-a-secret' }
            expect(decideStoredApiKeyAuth(broken, plaintext, 'legacy')).toEqual({ status: 'reject-rewrite', lookup })
            const storedDigest = { id: '1', apiKey: lookup, apiSecret: secret }
            expect(decideStoredApiKeyAuth(storedDigest, lookup, 'legacy')).toEqual({ status: 'reject' })
        })
    })

    describe('ownership', () => {
        it('records an interactive creator and inherits an API-key creator owner', () => {
            expect(ownerForCreatedApiKey({ id: 'user-1' })).toBe('user-1')
            expect(ownerForCreatedApiKey({ apiKeyOwnerUserId: 'user-2' })).toBe('user-2')
            expect(ownerForCreatedApiKey({})).toBeNull()
        })

        it('saves an API-key-created key with the creating key owner', async () => {
            let saved: Record<string, unknown> | undefined
            const query = {
                orderBy: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(),
                getMany: jest.fn(async () => (saved ? [saved] : []))
            }
            const repository = {
                create: jest.fn((row) => row),
                save: jest.fn(async (row) => {
                    saved = row as unknown as Record<string, unknown>
                    return row
                }),
                createQueryBuilder: jest.fn(() => query)
            }
            jest.mocked(getRunningExpressApp).mockReturnValue({
                identityManager: { getPlatformType: () => Platform.OPEN_SOURCE },
                AppDataSource: { getRepository: () => repository }
            } as never)

            await apikeyService.createApiKey(
                {
                    permissions: ['chatflows:view'],
                    isOrganizationAdmin: false,
                    activeWorkspaceId: 'team-1',
                    apiKeyOwnerUserId: 'user-2'
                },
                'Child key',
                ['chatflows:view']
            )

            expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'user-2' }))
        })
    })

    describe('permission restrictions', () => {
        const actor = {
            permissions: ['authentication:manage'],
            isOrganizationAdmin: true,
            activeWorkspaceId: 'team-1'
        }

        it('refuses authentication permissions on create and update', async () => {
            await expect(apikeyService.createApiKey(actor, 'Automation', ['authentication:manage'])).rejects.toMatchObject({
                statusCode: 400
            })
            await expect(apikeyService.updateApiKey(actor, 'credential-1', 'Automation', ['authentication:manage'])).rejects.toMatchObject({
                statusCode: 400
            })
        })
    })
})
