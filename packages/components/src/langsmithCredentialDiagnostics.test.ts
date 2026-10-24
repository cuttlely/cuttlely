import { AsyncLocalStorage } from 'async_hooks'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { Client } from 'langsmith'
import { additionalCallbacks } from './handler'
import * as utils from './utils'
import { pbkdf2Sync } from 'crypto'
import { describeLangSmithCredential, keepConfiguredLangSmithTarget, langSmithFailureLoggingFetch } from './langsmithCredentialDiagnostics'

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
            apiKeyFingerprint: pbkdf2Sync(key, 'cuttlely-langsmith-fingerprint', 2000, 6, 'sha256').toString('hex'),
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
        expect(shape.apiKeyFingerprint).toBe('')
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

    it('logs failed uploads with the flow id and the credential shape', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as any
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const shape = describeLangSmithCredential('cred-1', { langSmithApiKey: 'x' }, 'lsv2_pt_secretvalue', '', 'proj')
        const res = await langSmithFailureLoggingFetch({ flowId: 'flow-1', shape })('https://api.smith.langchain.com/runs/multipart', {
            headers: { 'x-api-key': 'secret-value' }
        })
        expect(res.status).toBe(403)
        expect(warn).toHaveBeenCalledTimes(1)
        const line = warn.mock.calls[0][0] as string
        expect(line).toContain('status=403')
        expect(line).toContain('path=/runs/multipart')
        expect(line).toContain('flowId=flow-1')
        expect(line).toContain('"credentialId":"cred-1"')
        expect(line).toContain('"apiKeyPrefix":"lsv2"')
        expect(line).not.toContain('secret-value')
        expect(line).not.toContain('secretvalue')
    })

    it('stays quiet on success', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 }) as any
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        await langSmithFailureLoggingFetch({})('https://api.smith.langchain.com/runs/multipart')
        expect(warn).not.toHaveBeenCalled()
    })
})

describe('keepConfiguredLangSmithTarget', () => {
    it('keepConfiguredLangSmithTarget restores the client and project', () => {
        const client = {}
        const tracer = { client: {}, projectName: 'default' }
        keepConfiguredLangSmithTarget(tracer, { client, projectName: 'NAVI-Micro' })
        expect(tracer.client).toBe(client)
        expect(tracer.projectName).toBe('NAVI-Micro')
        keepConfiguredLangSmithTarget(tracer, {})
        expect(tracer.client).toBe(client)
        expect(tracer.projectName).toBe('default')
    })
})

describe('LangSmith tracer inside runWithAbortSignal', () => {
    beforeAll(() => {
        AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage())
    })
    afterEach(() => jest.restoreAllMocks())

    it('the tracer from additionalCallbacks keeps the credential client and the flow project', async () => {
        jest.spyOn(utils, 'getCredentialData').mockResolvedValue({
            langSmithApiKey: 'lsv2_pt_test_only_value',
            langSmithEndpoint: 'https://api.smith.langchain.com'
        })
        const options = {
            chatflowid: 'flow-1',
            analytic: JSON.stringify({ langSmith: { status: true, credentialId: 'cred-1', projectName: 'NAVI-Micro' } })
        }
        const signal = new AbortController().signal
        await AsyncLocalStorageProviderSingleton.runWithConfig({ signal }, async () => {
            // The abort signal still reaches runnables through the implicit config.
            expect(AsyncLocalStorageProviderSingleton.getRunnableConfig()?.signal).toBe(signal)
            const callbacks = await additionalCallbacks({ inputs: {} } as any, options)
            const tracer = callbacks.find((cb: any) => cb?.name === 'langchain_tracer')
            expect(tracer).toBeDefined()
            expect(tracer.projectName).toBe('NAVI-Micro')
            expect(tracer.client).toBeInstanceOf(Client)
            expect((tracer.client as any).apiKey).toBe('lsv2_pt_test_only_value')
        })
    })
})
