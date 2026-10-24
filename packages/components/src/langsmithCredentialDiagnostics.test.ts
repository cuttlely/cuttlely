import { createHash } from 'crypto'
import { describeLangSmithCredential, langSmithFailureLoggingFetch } from './langsmithCredentialDiagnostics'

describe('describeLangSmithCredential', () => {
    const key = 'lsv2_pt_' + 'a'.repeat(40) + '_' + 'b'.repeat(10)

    it('reports the shape without the key', () => {
        const shape = describeLangSmithCredential(
            'cred-1',
            { langSmithApiKey: key, langSmithEndpoint: 'https://api.smith.langchain.com' },
            key,
            'https://api.smith.langchain.com',
            'proj'
        )
        expect(shape).toEqual({
            credentialId: 'cred-1',
            credentialDataEmpty: false,
            fieldNames: ['langSmithApiKey', 'langSmithEndpoint'],
            apiKeyPrefix: 'lsv2_',
            apiKeyLength: key.length,
            apiKeySha256: createHash('sha256').update(key).digest('hex').slice(0, 12),
            endpoint: 'https://api.smith.langchain.com',
            project: 'proj'
        })
        expect(JSON.stringify(shape)).not.toContain(key.slice(5))
    })

    it('flags empty credential data and a missing key', () => {
        const shape = describeLangSmithCredential('cred-2', {}, undefined, undefined, undefined)
        expect(shape.credentialDataEmpty).toBe(true)
        expect(shape.apiKeyLength).toBe(0)
        expect(shape.apiKeyPrefix).toBe('')
        expect(shape.apiKeySha256).toBe('')
        expect(shape.endpoint).toBe('(default)')
        expect(shape.project).toBe('(default)')
    })

    it('shows less of a short value', () => {
        expect(describeLangSmithCredential('c', {}, 'abcdefgh', '', '').apiKeyPrefix).toBe('ab')
    })
})

describe('langSmithFailureLoggingFetch', () => {
    const realFetch = global.fetch
    afterEach(() => {
        global.fetch = realFetch
        jest.restoreAllMocks()
    })

    it('logs failed uploads with the flow and credential ids', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as any
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const res = await langSmithFailureLoggingFetch({ flowId: 'flow-1', credentialId: 'cred-1' })(
            'https://api.smith.langchain.com/runs/multipart',
            { headers: { 'x-api-key': 'secret-value' } }
        )
        expect(res.status).toBe(403)
        expect(warn).toHaveBeenCalledTimes(1)
        const line = warn.mock.calls[0][0] as string
        expect(line).toContain('status=403')
        expect(line).toContain('path=/runs/multipart')
        expect(line).toContain('flowId=flow-1')
        expect(line).toContain('credentialId=cred-1')
        expect(line).not.toContain('secret-value')
    })

    it('stays quiet on success', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 }) as any
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        await langSmithFailureLoggingFetch({})('https://api.smith.langchain.com/runs/multipart')
        expect(warn).not.toHaveBeenCalled()
    })
})
