import { mergeCredentialUpdate, REDACTED_CREDENTIAL_VALUE } from '.'

describe('mergeCredentialUpdate', () => {
    const stored = {
        langSmithApiKey: 'lsv2_pt_stored_test_value',
        langSmithEndpoint: 'https://api.smith.langchain.com',
        redisUrl: 'redis://user:pw-test@host:6379'
    }

    it('keeps the stored value when the blank placeholder value comes back', () => {
        const merged = mergeCredentialUpdate(stored, { langSmithApiKey: REDACTED_CREDENTIAL_VALUE })
        expect(merged.langSmithApiKey).toBe('lsv2_pt_stored_test_value')
    })

    it('does not store the blank placeholder value for a field that had no value', () => {
        const merged = mergeCredentialUpdate({}, { langSmithApiKey: REDACTED_CREDENTIAL_VALUE })
        expect(merged).toEqual({})
    })

    it('keeps the stored URL when its masked form comes back', () => {
        const merged = mergeCredentialUpdate(stored, { redisUrl: 'redis://user:\u2022\u2022\u2022\u2022\u2022\u2022@host:6379' })
        expect(merged.redisUrl).toBe('redis://user:pw-test@host:6379')
    })

    it('applies real new values and keeps fields that were not sent', () => {
        const merged = mergeCredentialUpdate(stored, { langSmithApiKey: 'lsv2_pt_new_test_value', redisUrl: 'redis://host:6380' })
        expect(merged).toEqual({
            langSmithApiKey: 'lsv2_pt_new_test_value',
            langSmithEndpoint: 'https://api.smith.langchain.com',
            redisUrl: 'redis://host:6380'
        })
    })

    it('treats a missing update as no change', () => {
        expect(mergeCredentialUpdate(stored, undefined)).toEqual(stored)
        expect(mergeCredentialUpdate(stored, null)).toEqual(stored)
    })
})
