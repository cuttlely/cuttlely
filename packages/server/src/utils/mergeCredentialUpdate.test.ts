import { hasMaskedUrlPassword, mergeCredentialUpdate, REDACTED_CREDENTIAL_VALUE } from '.'

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

    it('never saves the mask, even from an older masked URL', () => {
        const merged = mergeCredentialUpdate(stored, { redisUrl: 'redis://user:\u2022\u2022\u2022\u2022\u2022\u2022@old-host:6379' })
        expect(merged.redisUrl).toBe('redis://user:pw-test@host:6379')
    })

    it('never saves a percent-encoded mask', () => {
        const encoded = new URL('redis://user:\u2022\u2022\u2022\u2022\u2022\u2022@old-host:6379').toString()
        expect(encoded).not.toContain('\u2022')
        expect(mergeCredentialUpdate(stored, { redisUrl: encoded }).redisUrl).toBe('redis://user:pw-test@host:6379')
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

    it('fails closed: a percent-encoded bullet in the password keeps the stored URL', () => {
        for (const redisUrl of ['redis://user:%E2%80%A2%E2%80%A2@new-host:6379', 'redis://user:pw%e2%80%a2@new-host:6379']) {
            expect(mergeCredentialUpdate(stored, { redisUrl }).redisUrl).toBe('redis://user:pw-test@host:6379')
        }
    })

    it('fails closed: a URL that does not parse or decode keeps the stored URL', () => {
        for (const redisUrl of ['redis://user:%ZZ@new-host:6379', 'http://user:pw@[::1', 'redis://user:%E0%A4%A@host:6379']) {
            expect(hasMaskedUrlPassword(redisUrl)).toBe(true)
            expect(mergeCredentialUpdate(stored, { redisUrl }).redisUrl).toBe('redis://user:pw-test@host:6379')
        }
    })
})

describe('hasMaskedUrlPassword', () => {
    it('is false for plain values and real URLs', () => {
        expect(hasMaskedUrlPassword('lsv2_pt_new_test_value')).toBe(false)
        expect(hasMaskedUrlPassword('not a url %ZZ')).toBe(false)
        expect(hasMaskedUrlPassword('redis://user:pw%20x@host:6379')).toBe(false)
        expect(hasMaskedUrlPassword('https://api.smith.langchain.com')).toBe(false)
    })

    it('is true for the mask as shown, encoded in any case, or in a URL that fails to parse or decode', () => {
        expect(hasMaskedUrlPassword('redis://user:\u2022\u2022\u2022\u2022\u2022\u2022@host:6379')).toBe(true)
        expect(hasMaskedUrlPassword('redis://user:%E2%80%A2@host:6379')).toBe(true)
        expect(hasMaskedUrlPassword('redis://user:%e2%80%a2@host:6379')).toBe(true)
        expect(hasMaskedUrlPassword('redis://user:%ZZ@host:6379')).toBe(true)
        expect(hasMaskedUrlPassword('http://user:pw@[::1')).toBe(true)
    })
})
