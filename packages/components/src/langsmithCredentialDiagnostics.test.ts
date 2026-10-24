import { AsyncLocalStorage } from 'async_hooks'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { Client } from 'langsmith'
import { AnalyticHandler, additionalCallbacks } from './handler'
import * as utils from './utils'
import {
    describeLangSmithCredential,
    keepConfiguredLangSmithTarget,
    langSmithClientConfig,
    langSmithFailureLoggingFetch,
    operationForLog
} from './langsmithCredentialDiagnostics'

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
            apiKeyLength: key.length,
            endpoint: 'https://api.smith.langchain.com',
            project: 'proj'
        })
        expect(Object.keys(shape)).not.toContain('apiKeyPrefix')
        expect(Object.keys(shape)).not.toContain('apiKeyFingerprint')
        expect(JSON.stringify(shape)).not.toContain('lsv2')
        expect(JSON.stringify(shape)).not.toContain(key.slice(0, 3))
    })

    it('flags empty credential data and a missing key', () => {
        const shape = describeLangSmithCredential('cred-2', {}, undefined, undefined, undefined)
        expect(shape.credentialDataEmpty).toBe(true)
        expect(shape.apiKeyLength).toBe(0)
        expect(shape.endpoint).toBe('(default)')
        expect(shape.project).toBe('(default)')
    })

    it('logs the same shape for two different values of the same length', () => {
        const a = describeLangSmithCredential('c', {}, 'lsv2_pt_aaaaaaaa', '', '')
        const b = describeLangSmithCredential('c', {}, 'zzzzzzzzzzzzzzzz', '', '')
        expect(a).toEqual(b)
        expect(a.apiKeyLength).toBe(16)
    })
})

describe('langSmithFailureLoggingFetch', () => {
    const realFetch = global.fetch
    afterEach(() => {
        global.fetch = realFetch
        jest.restoreAllMocks()
    })

    it('logs failed uploads with the flow id and the credential shape', async () => {
        global.fetch = jest.fn().mockResolvedValue(new Response('forbidden', { status: 403 })) as any
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
        expect(line).toContain('"apiKeyLength":19')
        expect(line).not.toContain('lsv2')
        expect(line).not.toContain('apiKeyPrefix')
        expect(line).not.toContain('apiKeyFingerprint')
        expect(line).not.toContain('secret-value')
        expect(line).not.toContain('secretvalue')
    })

    it('hands the SDK the status and headers of a failed response but not its body or status text', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            new Response('echo x-api-key: secret-value', {
                status: 429,
                statusText: 'echo secret-value',
                headers: {
                    'retry-after': '3',
                    'content-type': 'application/json',
                    'set-cookie': 'session=secret-value',
                    'x-echo-api-key': 'secret-value',
                    'www-authenticate': 'Bearer secret-value'
                }
            })
        ) as any
        jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const res = await langSmithFailureLoggingFetch({ flowId: 'flow-1' })('https://api.smith.langchain.com/runs/multipart')
        expect(res.ok).toBe(false)
        expect(res.status).toBe(429)
        expect(res.statusText).toBe('')
        expect(res.headers.get('retry-after')).toBe('3')
        expect(res.headers.get('content-type')).toBe('application/json')
        expect(res.headers.get('x-echo-api-key')).toBeNull()
        expect(res.headers.get('www-authenticate')).toBeNull()
        expect([...res.headers.keys()].sort()).toEqual(['content-type', 'retry-after'])
        expect(JSON.stringify([...res.headers.entries()])).not.toContain('secret-value')
        const body = await res.text()
        expect(body).toBe('LangSmith request failed with status 429')
        expect(body).not.toContain('secret-value')
    })

    it('logs a request that fails outright and rethrows it without the original message', async () => {
        const err = new TypeError('fetch failed https://u:secret-value@api.example.test/?token=secret-value')
        global.fetch = jest.fn().mockRejectedValue(err) as any
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const shape = describeLangSmithCredential('cred-1', {}, 'lsv2_pt_secretvalue', '', 'proj')
        await expect(
            langSmithFailureLoggingFetch({ flowId: 'flow-1', shape })('https://api.smith.langchain.com/runs/multipart')
        ).rejects.toMatchObject({ name: 'TypeError', message: 'LangSmith request failed (TypeError)' })
        expect(warn).toHaveBeenCalledTimes(1)
        const line = warn.mock.calls[0][0] as string
        expect(line).toContain('error=TypeError')
        expect(line).toContain('path=/runs/multipart')
        expect(line).toContain('flowId=flow-1')
        expect(line).toContain('"credentialId":"cred-1"')
        expect(line).not.toContain('secret-value')
        expect(line).not.toContain('secretvalue')
    })

    it('logs only the origin of the endpoint', () => {
        const shape = describeLangSmithCredential('c', {}, '', 'https://u:secret-value@eu.api.example.test/base?token=secret-value#x', 'p')
        expect(shape.endpoint).toBe('https://eu.api.example.test')
        expect(describeLangSmithCredential('c', {}, '', 'https://proxy.example.test/secret-value/api', 'p').endpoint).toBe(
            'https://proxy.example.test'
        )
        expect(describeLangSmithCredential('c', {}, '', 'not a url secret-value', 'p').endpoint).toBe('(unparsed)')
    })

    it('logs a fixed operation name, never a path that carries a token', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        global.fetch = jest.fn().mockResolvedValue(new Response('x', { status: 500 })) as any
        await langSmithFailureLoggingFetch({})('https://proxy.example.test/secret-value/runs/multipart')
        global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed secret-value')) as any
        await expect(langSmithFailureLoggingFetch({})('https://proxy.example.test/secret-value/other')).rejects.toThrow('TypeError')
        const lines = warn.mock.calls.map((c) => String(c[0]))
        expect(lines[0]).toContain('path=/runs/multipart')
        expect(lines[1]).toContain('path=(other)')
        for (const line of lines) expect(line).not.toContain('secret-value')
        expect(operationForLog('/x/runs/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('/runs/:id')
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

    const KEYLESS = [{}, { langSmithApiKey: '' }, { langSmithApiKey: '   ' }, { langSmithEndpoint: 'https://collector.example.test' }]

    const withServerKeys = async (run: () => Promise<void>) => {
        const saved = { LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY, LANGCHAIN_API_KEY: process.env.LANGCHAIN_API_KEY }
        process.env.LANGSMITH_API_KEY = 'lsv2_pt_server_env_test_value'
        process.env.LANGCHAIN_API_KEY = 'lsv2_pt_server_env_test_value2'
        try {
            await run()
        } finally {
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name]
                else process.env[name] = value
            }
        }
    }

    it('a flow credential with no key gets no tracer, so no server key or profile auth is sent (docs/reference/langsmith-tracing.md)', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const fetchSpy = jest.spyOn(globalThis, 'fetch')
        await withServerKeys(async () => {
            for (const data of KEYLESS) {
                jest.spyOn(utils, 'getCredentialData').mockResolvedValue(data)
                const options = {
                    chatflowid: 'flow-2',
                    analytic: JSON.stringify({ langSmith: { status: true, credentialId: 'cred-empty', projectName: 'Flow-Project' } })
                }
                const callbacks = await additionalCallbacks({ inputs: {} } as any, options)
                expect(callbacks.find((cb: any) => cb?.name === 'langchain_tracer')).toBeUndefined()
            }
        })
        expect(fetchSpy).not.toHaveBeenCalled()
        const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('tracing off'))
        expect(lines).toHaveLength(KEYLESS.length)
        for (const line of lines) expect(line).not.toContain('lsv2_pt_server_env')
        warn.mockRestore()
        fetchSpy.mockRestore()
    })

    it('AnalyticHandler leaves LangSmith off for a flow credential with no key and on for one with a key', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        await withServerKeys(async () => {
            for (const [i, data] of KEYLESS.entries()) {
                const handler = AnalyticHandler.getInstance({ inputs: {} } as any, { chatId: `chat-keyless-${i}`, chatflowid: 'flow-3' })
                await handler.initializeProvider('langSmith', { projectName: 'P', credentialId: 'cred-empty' }, data)
                expect((handler as any).handlers.langSmith).toBeUndefined()
                AnalyticHandler.resetInstance(`chat-keyless-${i}`)
            }
            const handler = AnalyticHandler.getInstance({ inputs: {} } as any, { chatId: 'chat-keyed', chatflowid: 'flow-3' })
            await handler.initializeProvider(
                'langSmith',
                { projectName: 'P', credentialId: 'cred-1' },
                { langSmithApiKey: 'lsv2_pt_test_only_value' }
            )
            expect((handler as any).handlers.langSmith.client).toBeInstanceOf(Client)
            expect((handler as any).handlers.langSmith.client.apiKey).toBe('lsv2_pt_test_only_value')
            AnalyticHandler.resetInstance('chat-keyed')
        })
        warn.mockRestore()
    })

    it('builds a LangSmith client config only for a nonblank key', () => {
        expect(langSmithClientConfig(undefined, undefined)).toBeUndefined()
        expect(langSmithClientConfig('', 'https://eu.example.test')).toBeUndefined()
        expect(langSmithClientConfig('  ', 'https://eu.example.test')).toBeUndefined()
        expect(langSmithClientConfig(42, 'https://eu.example.test')).toBeUndefined()
        expect(langSmithClientConfig('k', undefined)).toEqual({ apiUrl: 'https://api.smith.langchain.com', apiKey: 'k' })
        expect(langSmithClientConfig('k', 'https://eu.example.test')).toEqual({ apiUrl: 'https://eu.example.test', apiKey: 'k' })
    })
})
