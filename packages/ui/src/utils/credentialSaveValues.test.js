import { credentialSaveValues, saveErrorMessage } from './credentialSaveValues'

const REDACTED_CREDENTIAL_VALUE = 'test-blank-placeholder'
jest.mock('@/store/constant', () => ({ REDACTED_CREDENTIAL_VALUE: 'test-blank-placeholder' }))

const M = '\u2022\u2022\u2022\u2022\u2022\u2022'

describe('credentialSaveValues', () => {
    it('leaves out the blank placeholder value and an unchanged masked URL', () => {
        const shown = { apiKey: REDACTED_CREDENTIAL_VALUE, url: `redis://u:${M}@h:6379/0` }
        const r = credentialSaveValues({ ...shown, region: 'eu' }, shown)
        expect(r.plainDataObj).toEqual({ region: 'eu' })
        expect(r.maskedEdits).toEqual([])
    })
    it('reports an edited masked URL instead of dropping it', () => {
        const shown = { url: `redis://u:${M}@h:6379/0` }
        const r = credentialSaveValues({ url: `redis://u:${M}@other:6379/1` }, shown)
        expect(r.plainDataObj).toEqual({})
        expect(r.maskedEdits).toEqual(['url'])
    })
    it('sends a fully replaced URL and a new secret', () => {
        const shown = { url: `redis://u:${M}@h:6379/0`, apiKey: REDACTED_CREDENTIAL_VALUE }
        const r = credentialSaveValues({ url: 'redis://u:new@h:6379/0', apiKey: 'sk-new' }, shown)
        expect(r.plainDataObj).toEqual({ url: 'redis://u:new@h:6379/0', apiKey: 'sk-new' })
        expect(r.maskedEdits).toEqual([])
    })

    it('treats a percent-encoded mask as masked', () => {
        const shown = { url: `redis://u:${M}@h:6379/0` }
        const encoded = new URL(shown.url).toString()
        expect(encoded).not.toContain(M)
        const r = credentialSaveValues({ url: encoded }, shown)
        expect(r.plainDataObj).toEqual({})
        expect(r.maskedEdits).toEqual(['url'])
    })

    it('reports an edit made in place on the object that was shown when compared with a copy', () => {
        const loaded = { url: `redis://u:${M}@h:6379/0` }
        const shown = { ...loaded }
        loaded.url = `redis://u:${M}@other:6379/0`
        expect(credentialSaveValues(loaded, shown).maskedEdits).toEqual(['url'])
    })
})

describe('saveErrorMessage', () => {
    it('uses the server message, then the error message', () => {
        expect(saveErrorMessage({ response: { data: { message: 'server says' } } })).toBe('server says')
        expect(saveErrorMessage({ response: { data: 'plain' } })).toBe('plain')
        expect(saveErrorMessage(new Error('Enter the full URL'))).toBe('Enter the full URL')
    })
})
