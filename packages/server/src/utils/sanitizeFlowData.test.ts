import {
    isChatflowKeyProtected,
    isSecretHeaderName,
    isSecretInputName,
    looksLikeSecretValue,
    publicChatbotDisplayConfig,
    publicChatflowSummary,
    sanitizeNodeInputs,
    scrubSecrets,
    sanitizeFlowDataForPublicEndpoint
} from './sanitizeFlowData'

const makeFlowData = (nodes: object[], edges: object[] = []) => JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } })

const makeNode = (inputs: Record<string, unknown>, inputParams: object[], extra: object = {}) => ({
    id: 'node_0',
    position: { x: 0, y: 0 },
    type: 'customNode',
    data: {
        id: 'node_0',
        name: 'testNode',
        label: 'Test Node',
        inputs,
        inputParams,
        ...extra
    }
})

describe('sanitizeFlowDataForPublicEndpoint', () => {
    it('strips password-type inputs', () => {
        const flowData = makeFlowData([
            makeNode({ apiKey: 'sk-secret', model: 'gpt-4' }, [
                { name: 'apiKey', type: 'password' },
                { name: 'model', type: 'string' }
            ])
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(result.nodes[0].data.inputs).not.toHaveProperty('apiKey')
        expect(result.nodes[0].data.inputs.model).toBe('gpt-4')
    })

    it('strips file-type inputs', () => {
        const flowData = makeFlowData([
            makeNode({ filePath: '/data/secret.pdf', label: 'loader' }, [
                { name: 'filePath', type: 'file' },
                { name: 'label', type: 'string' }
            ])
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(result.nodes[0].data.inputs).not.toHaveProperty('filePath')
        expect(result.nodes[0].data.inputs.label).toBe('loader')
    })

    it('strips folder-type inputs', () => {
        const flowData = makeFlowData([
            makeNode({ folderPath: '/home/user/docs', name: 'ingest' }, [
                { name: 'folderPath', type: 'folder' },
                { name: 'name', type: 'string' }
            ])
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(result.nodes[0].data.inputs).not.toHaveProperty('folderPath')
        expect(result.nodes[0].data.inputs.name).toBe('ingest')
    })

    it('removes credential field from node data', () => {
        const flowData = makeFlowData([makeNode({ model: 'gpt-4' }, [{ name: 'model', type: 'string' }], { credential: 'cred-uuid-123' })])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(result.nodes[0].data).not.toHaveProperty('credential')
    })

    it('removes Authorization header from headers input, preserves other headers', () => {
        const headers = JSON.stringify({ Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' })
        const flowData = makeFlowData([
            makeNode({ headers, url: 'https://example.com' }, [
                { name: 'headers', type: 'json' },
                { name: 'url', type: 'string' }
            ])
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        const sanitizedHeaders = JSON.parse(result.nodes[0].data.inputs.headers)
        expect(sanitizedHeaders).not.toHaveProperty('Authorization')
        expect(sanitizedHeaders['Content-Type']).toBe('application/json')
    })

    it('removes x-api-key header case-insensitively', () => {
        const headers = JSON.stringify({ 'X-API-Key': 'my-key', Accept: 'application/json' })
        const flowData = makeFlowData([makeNode({ headers }, [{ name: 'headers', type: 'json' }])])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        const sanitizedHeaders = JSON.parse(result.nodes[0].data.inputs.headers)
        expect(sanitizedHeaders).not.toHaveProperty('X-API-Key')
        expect(sanitizedHeaders.Accept).toBe('application/json')
    })

    it('removes Authorization from array-format headers (HTTP agentflow node)', () => {
        const headers = [
            { key: 'Authorization', value: 'Bearer secret-token' },
            { key: 'Content-Type', value: 'application/json' }
        ]
        const flowData = makeFlowData([makeNode({ headers }, [{ name: 'headers', type: 'array' }])])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        const sanitizedHeaders = result.nodes[0].data.inputs.headers
        expect(sanitizedHeaders).toEqual([{ key: 'Content-Type', value: 'application/json' }])
    })

    it('removes x-api-key case-insensitively from array-format headers', () => {
        const headers = [
            { key: 'X-API-Key', value: 'secret' },
            { key: 'Accept', value: 'application/json' }
        ]
        const flowData = makeFlowData([makeNode({ headers }, [{ name: 'headers', type: 'array' }])])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        const sanitizedHeaders = result.nodes[0].data.inputs.headers
        expect(sanitizedHeaders).toEqual([{ key: 'Accept', value: 'application/json' }])
    })

    it('preserves non-sensitive string inputs unchanged', () => {
        const flowData = makeFlowData([
            makeNode({ temperature: '0.7', maxTokens: '1024' }, [
                { name: 'temperature', type: 'string' },
                { name: 'maxTokens', type: 'number' }
            ])
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(result.nodes[0].data.inputs.temperature).toBe('0.7')
        expect(result.nodes[0].data.inputs.maxTokens).toBe('1024')
    })

    it('preserves startAgentflow node inputs used by the embed widget', () => {
        const formInputTypes = [{ name: 'email', type: 'string', label: 'Email' }]
        const flowData = makeFlowData([
            makeNode(
                { startInputType: 'formInput', formTitle: 'Contact Us', formDescription: 'Fill out the form', formInputTypes },
                [
                    { name: 'startInputType', type: 'options' },
                    { name: 'formTitle', type: 'string' },
                    { name: 'formDescription', type: 'string' },
                    { name: 'formInputTypes', type: 'datagrid' }
                ],
                { name: 'startAgentflow' }
            )
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        const inputs = result.nodes[0].data.inputs
        expect(inputs.startInputType).toBe('formInput')
        expect(inputs.formTitle).toBe('Contact Us')
        expect(inputs.formDescription).toBe('Fill out the form')
        expect(inputs.formInputTypes).toEqual(formInputTypes)
    })

    it('returns empty nodes/edges structure for malformed flowData', () => {
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint('not-valid-json'))
        expect(result).toEqual({ nodes: [], edges: [] })
    })

    it('returns the original string unchanged when flowDataString is empty', () => {
        expect(sanitizeFlowDataForPublicEndpoint('')).toBe('')
    })

    it('drops headers when inputParams is missing', () => {
        const flowData = makeFlowData([
            {
                id: 'n0',
                type: 'x',
                data: { inputs: { headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' } } }
            }
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        // No field definition: the whole input is dropped.
        expect(result.nodes[0].data.inputs).toEqual({})
    })

    it('does not crash when a node has no inputParams', () => {
        const flowData = makeFlowData([{ id: 'n0', type: 'x', data: { inputs: { foo: 'bar' } } }])
        expect(() => sanitizeFlowDataForPublicEndpoint(flowData)).not.toThrow()
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(result.nodes[0].data.inputs).toEqual({})
    })
})

describe('isChatflowKeyProtected', () => {
    it('is true only for a non-empty key id', () => {
        expect(isChatflowKeyProtected('apikey-1')).toBe(true)
        expect(isChatflowKeyProtected('')).toBe(false)
        expect(isChatflowKeyProtected(null)).toBe(false)
        expect(isChatflowKeyProtected(undefined)).toBe(false)
    })
})

describe('isSecretInputName', () => {
    it('flags credential-like names and not token-count settings', () => {
        for (const name of [
            'openAIApiKey',
            'api_key',
            'clientSecret',
            'accessToken',
            'PASSWORD',
            'authorization',
            'googleKey',
            'accessKey',
            'privateKey',
            'secretAccessKey',
            'credential',
            'credentialId',
            'bearerToken',
            'key'
        ]) {
            expect(isSecretInputName(name)).toBe(true)
        }
        for (const name of [
            'maxTokens',
            'maxOutputTokens',
            'maxTokenLimit',
            'max_tokens_to_sample',
            'memoryKey',
            'inputKey',
            'outputKey',
            'metadataKey',
            'omitMetadataKeys',
            'keyPrefix',
            'sessionId',
            'modelName',
            'temperature'
        ]) {
            expect(isSecretInputName(name)).toBe(false)
        }
    })
})

describe('sanitizeFlowDataForPublicEndpoint allowlist', () => {
    it('removes an input with no field definition that carries a key', () => {
        const flowData = makeFlowData([
            makeNode({ openAIApiKey: 'sk-FAKE-TEST-123456', modelName: 'gpt-4.1-mini' }, [{ name: 'modelName', type: 'string' }])
        ])
        const raw = sanitizeFlowDataForPublicEndpoint(flowData)
        expect(raw).not.toContain('sk-FAKE-TEST-123456')
        const result = JSON.parse(raw)
        expect(result.nodes[0].data.inputs).toEqual({ modelName: 'gpt-4.1-mini' })
    })

    it('removes any input with no field definition', () => {
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(makeFlowData([makeNode({ extra: 'value' }, [])])))
        expect(result.nodes[0].data.inputs).toEqual({})
    })

    it('keeps inputs defined as anchors', () => {
        const flowData = makeFlowData([
            makeNode({ model: '{{chatOpenAI_0.data.instance}}' }, [], { inputAnchors: [{ name: 'model', type: 'BaseChatModel' }] })
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(result.nodes[0].data.inputs).toEqual({ model: '{{chatOpenAI_0.data.instance}}' })
    })

    it('drops declared inputs with clear credential names, whatever their type', () => {
        const names = ['myApiKey', 'clientSecret', 'accessToken', 'dbPassword', 'API_KEY']
        const inputs = Object.fromEntries(names.map((name) => [name, 'plain']))
        const run = (type: string) =>
            JSON.parse(
                sanitizeFlowDataForPublicEndpoint(
                    makeFlowData([
                        makeNode({ ...inputs, temperature: 0.2 }, [
                            ...names.map((name) => ({ name, type })),
                            { name: 'temperature', type: 'number' }
                        ])
                    ])
                )
            ).nodes[0].data.inputs
        // Clear credential names are dropped by name even when declared as plain strings.
        expect(run('string')).toEqual({ temperature: 0.2 })
        expect(run('password')).toEqual({ temperature: 0.2 })
    })

    it('removes defined inputs whose value looks like a key', () => {
        const flowData = makeFlowData([
            makeNode({ note: 'sk-FAKE-TEST-999', other: 'xai-FAKE-1', prompt: 'You are helpful' }, [
                { name: 'note', type: 'string' },
                { name: 'other', type: 'string' },
                { name: 'prompt', type: 'string' }
            ])
        ])
        const raw = sanitizeFlowDataForPublicEndpoint(flowData)
        expect(raw).not.toContain('FAKE')
        expect(JSON.parse(raw).nodes[0].data.inputs).toEqual({ prompt: 'You are helpful' })
    })
})

// Seven credential shapes a saved node can carry. All values are fake.
const variantParams = [
    { name: 'config', type: 'json' },
    { name: 'list', type: 'array' },
    { name: 'prompt', type: 'string' },
    { name: 'note', type: 'string' },
    { name: 'googleKey', type: 'string' },
    { name: 'credentialId', type: 'string' },
    { name: 'headers', type: 'array' },
    { name: 'temperature', type: 'number' }
]
const variantInputs = {
    config: { a: { b: 'sk-FAKE-NESTED-1' }, keep: 'ok' },
    list: ['fine', 'sk-FAKE-ARRAY-1'],
    prompt: 'Use the key sk-FAKE-SENTENCE-1 when asked',
    note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEsig',
    googleKey: 'AIzaFAKEFAKEFAKEFAKE123',
    credentialId: 'cred-FAKE-ID-1',
    headers: [
        { key: 'X-Custom-Auth', value: 'FAKE-HDR-1' },
        { key: 'Accept', value: 'application/json' }
    ],
    temperature: 0.2
}
const variantLeaks = ['FAKE-NESTED', 'FAKE-ARRAY', 'FAKE-SENTENCE', 'FAKEsig', 'AIzaFAKE', 'cred-FAKE-ID', 'FAKE-HDR']
const variantKept = {
    config: { a: {}, keep: 'ok' },
    list: ['fine'],
    headers: [{ key: 'Accept', value: 'application/json' }],
    temperature: 0.2
}

describe('seven credential shapes', () => {
    it('removes each one from a public flow graph and keeps the safe parts', () => {
        const raw = sanitizeFlowDataForPublicEndpoint(makeFlowData([makeNode(variantInputs, variantParams)]))
        for (const leak of variantLeaks) expect(raw).not.toContain(leak)
        expect(JSON.parse(raw).nodes[0].data.inputs).toEqual(variantKept)
    })

    it('drops headers whose name mentions auth, key, token, secret, session or cookie', () => {
        for (const name of ['Authorization', 'X-Custom-Auth', 'X-Api-Key', 'X-Token', 'Client-Secret', 'X-Session', 'Cookie']) {
            expect(isSecretHeaderName(name)).toBe(true)
        }
        expect(isSecretHeaderName('Accept')).toBe(false)
        const flowData = makeFlowData([
            makeNode({ headers: JSON.stringify({ 'X-Custom-Auth': 'FAKE-HDR-2', Accept: 'application/json' }) }, [
                { name: 'headers', type: 'json' }
            ])
        ])
        const result = JSON.parse(sanitizeFlowDataForPublicEndpoint(flowData))
        expect(JSON.parse(result.nodes[0].data.inputs.headers)).toEqual({ Accept: 'application/json' })
    })
})

describe('public chatbot display config', () => {
    it('keeps only widget display fields', () => {
        const result = publicChatbotDisplayConfig({
            title: 'Bot',
            allowedOrigins: ['x'],
            overrideConfig: { a: 1 },
            botMessage: { textColor: '#000', secret: 'sk-FAKE-1' },
            leads: { status: true }
        })
        expect(result).toEqual({ title: 'Bot', botMessage: { textColor: '#000' } })
    })

    it('public chatflow summary carries no flow graph and no key id', () => {
        const summary = publicChatflowSummary({
            id: 'flow-1',
            name: 'Flow',
            isPublic: true,
            apikeyid: 'apikey-1',
            chatbotConfig: JSON.stringify({
                title: 'Bot',
                overrideConfig: { temperature: 0.1, openAIApiKey: 'sk-FAKE-2', note: 'eyJa.eyJb.c' }
            })
        })
        expect(summary).toEqual({
            id: 'flow-1',
            name: 'Flow',
            isPublic: true,
            hasApiKey: true,
            chatbotConfig: JSON.stringify({ title: 'Bot' })
        })
    })
})

describe('public config follow-up rules', () => {
    it('never returns overrideConfig from the public flow summary', () => {
        const summary = publicChatflowSummary({
            id: 'f',
            chatbotConfig: JSON.stringify({
                title: 'Bot',
                overrideConfig: { temperature: 0.2, headers: { Accept: 'a' }, vars: { databaseUrl: 'https://u:pw@db.example/app' } }
            })
        })
        expect(JSON.parse(summary.chatbotConfig as string)).toEqual({ title: 'Bot' })
        expect(JSON.stringify(summary)).not.toContain('overrideConfig')
    })

    it('drops nested auth and pass exactly but keeps passThrough and bypass', () => {
        expect(scrubSecrets({ auth: 'a', PASS: 'b', passThrough: true, bypass: 'yes', nested: [{ key: 'Auth', value: 'c' }] })).toEqual({
            passThrough: true,
            bypass: 'yes',
            nested: []
        })
    })

    it('keeps declared Jira-style inputs by type and checks only their values', () => {
        const params = [
            { name: 'projectKey', type: 'string' },
            { name: 'key', type: 'string' },
            { name: 'accessTokenUrl', type: 'string' },
            { name: 'apiToken', type: 'password' },
            { name: 'note', type: 'string' }
        ] as any
        const result = sanitizeNodeInputs(
            {
                projectKey: 'PROJ',
                key: 'PROJ-123',
                accessTokenUrl: 'https://example.atlassian.net/oauth/token',
                apiToken: 'plain',
                note: 'sk-FAKE-9',
                undeclaredToken: 'plain'
            },
            params,
            [{ name: 'sessionKey' }]
        )
        expect(result).toEqual({ projectKey: 'PROJ', key: 'PROJ-123', accessTokenUrl: 'https://example.atlassian.net/oauth/token' })
        expect(sanitizeNodeInputs({ sessionKey: 'x' }, [], [{ name: 'sessionKey' }])).toEqual({})
    })

    it('keeps loadConfig companion inputs and scrubs credentials inside them', () => {
        const params = [
            { name: 'llmModel', type: 'asyncOptions', loadConfig: true },
            { name: 'plain', type: 'string' }
        ] as any
        const result = sanitizeNodeInputs(
            {
                llmModel: 'chatOpenAI',
                llmModelConfig: {
                    modelName: 'gpt-x',
                    temperature: 0.2,
                    credential: 'cred-1',
                    FLOWISE_CREDENTIAL_ID: 'cred-1',
                    apiKey: 'sk-FAKE-9'
                },
                plainConfig: { a: 1 }
            },
            params
        )
        expect(result.llmModel).toBe('chatOpenAI')
        expect(result.plainConfig).toBeUndefined()
        const cfg = result.llmModelConfig as Record<string, unknown>
        expect(cfg.modelName).toBe('gpt-x')
        expect(cfg.temperature).toBe(0.2)
        expect(cfg.credential).toBeUndefined()
        expect(cfg.FLOWISE_CREDENTIAL_ID).toBeUndefined()
        expect(cfg.apiKey).toBeUndefined()
    })

    describe('serialized object inputs', () => {
        const params = [
            { name: 'llmModel', type: 'asyncOptions', loadConfig: true },
            { name: 'agentModel', type: 'asyncOptions', loadConfig: true },
            { name: 'extras', type: 'json' }
        ] as any

        it('cleans a JSON string field inside a loadConfig companion', () => {
            const result = sanitizeNodeInputs(
                {
                    llmModelConfig: {
                        modelName: 'm1',
                        jsonStr: JSON.stringify({
                            apiKey: 'FAKE-CMP-KEY',
                            region: 'r1',
                            headers: { 'X-Custom-Auth': 'FAKE-CMP-HDR', Accept: 'a' }
                        })
                    }
                },
                params
            )
            const cfg = result.llmModelConfig as Record<string, unknown>
            expect(cfg.modelName).toBe('m1')
            expect(JSON.parse(cfg.jsonStr as string)).toEqual({ region: 'r1', headers: { Accept: 'a' } })
            expect(JSON.stringify(result)).not.toContain('FAKE-CMP')
        })

        it('cleans a companion saved as a whole JSON string with no provider-shaped value', () => {
            const result = sanitizeNodeInputs(
                {
                    agentModelConfig: JSON.stringify({
                        modelName: 'm2',
                        apiKey: 'FAKE-AG-KEY',
                        headers: { 'X-Custom-Auth': 'FAKE-AG-HDR' }
                    })
                },
                params
            )
            expect(typeof result.agentModelConfig).toBe('string')
            expect(JSON.parse(result.agentModelConfig as string)).toEqual({ modelName: 'm2', headers: {} })
            expect(JSON.stringify(result)).not.toContain('FAKE-AG')
        })

        it('cleans a JSON string item in an ordinary json input and leaves plain strings alone', () => {
            const result = sanitizeNodeInputs({ extras: ['x', '{"apiKey":"FAKE-PRE-KEY","mode":"m"}', '{not json', '[1,2]'] }, params)
            expect(result.extras).toEqual(['x', '{"mode":"m"}', '{not json', '[1,2]'])
        })
    })

    describe('structured text in public display fields', () => {
        const jsonText = JSON.stringify({ apiKey: 'FAKE-DISP-KEY', text: 'hi' })
        const urlText = JSON.stringify({ u: 'https://user:pw@example.com/x' })
        const saved = {
            title: jsonText,
            welcomeMessage: urlText,
            errorMessage: 'https://user:pw@example.com/y',
            starterPrompts: [{ prompt: jsonText }, { prompt: urlText }, { prompt: 'Plain question' }],
            botMessage: { textColor: jsonText, backgroundColor: '#fff' },
            userMessage: { textColor: urlText }
        }
        const expectClean = (display: Record<string, unknown>) => {
            expect(display.title).toBeUndefined()
            expect(display.welcomeMessage).toBeUndefined()
            expect(display.errorMessage).toBeUndefined()
            expect(display.starterPrompts).toEqual([{ prompt: 'Plain question' }])
            expect(display.botMessage).toEqual({ backgroundColor: '#fff' })
            expect(display.userMessage).toEqual({})
            const serialized = JSON.stringify(display)
            for (const leak of ['FAKE-DISP-KEY', 'apiKey', 'user:pw@', 'example.com']) expect(serialized).not.toContain(leak)
        }

        it('drops JSON text and credential URLs from the public chatbot config', () => {
            expectClean(publicChatbotDisplayConfig(saved))
        })

        it('drops JSON text and credential URLs from the public chatflow chatbotConfig', () => {
            const summary = publicChatflowSummary({ id: 'f1', name: 'n', isPublic: true, chatbotConfig: JSON.stringify(saved) })
            expectClean(JSON.parse(summary.chatbotConfig as string))
        })

        it('keeps ordinary display text', () => {
            expect(publicChatbotDisplayConfig({ title: 'Hello {name}', welcomeMessage: 'See https://example.com/help' })).toEqual({
                title: 'Hello {name}',
                welcomeMessage: 'See https://example.com/help'
            })
        })
    })

    describe('broader credential patterns', () => {
        const params = [
            { name: 'callbackUrl', type: 'string' },
            { name: 'hookUrl', type: 'string' },
            { name: 'docsUrl', type: 'string' },
            { name: 'requestsGetHeaders', type: 'json' },
            { name: 'headers', type: 'json' },
            { name: 'extras', type: 'json' }
        ] as any

        it.each([
            'https://example.com/cb?refresh_token=FAKE-URL-1',
            'https://example.com/cb?X-Amz-Signature=FAKE-URL-2',
            'https://example.com/cb?Auth=FAKE-URL-3',
            'https://example.com/cb#client_credential=FAKE-URL-4',
            'https://example.com/cb?userPassword=FAKE-URL-5',
            'https://example.com/cb?subscriptionKey=FAKE-URL-6',
            'https://user:pw@example.com/cb'
        ])('drops a URL carrying a credential parameter: %s', (url) => {
            expect(sanitizeNodeInputs({ callbackUrl: url }, params)).toEqual({})
            expect(sanitizeNodeInputs({ extras: { url } }, params)).toEqual({ extras: {} })
        })

        it('keeps URLs with ordinary query parameters', () => {
            const docsUrl = 'https://example.com/search?q=cakes&page=2&sort=asc&lang=en#results'
            expect(sanitizeNodeInputs({ docsUrl, hookUrl: 'https://example.com/hook?id=7' }, params)).toEqual({
                docsUrl,
                hookUrl: 'https://example.com/hook?id=7'
            })
        })

        it('applies the header-name rule to any input ending in headers', () => {
            const result = sanitizeNodeInputs(
                {
                    requestsGetHeaders: { 'X-Custom-Auth': 'FAKE-HDR-1', Accept: 'application/json' },
                    extras: { proxyHeaders: { 'X-Session-Id': 'FAKE-HDR-2', 'X-Trace': 't1' } }
                },
                params
            )
            expect(result).toEqual({ requestsGetHeaders: { Accept: 'application/json' }, extras: { proxyHeaders: { 'X-Trace': 't1' } } })
        })

        it('checks a single { key, value } object like an array item', () => {
            expect(sanitizeNodeInputs({ headers: { key: 'X-Custom-Auth', value: 'FAKE-PAIR-1' } }, params)).toEqual({})
            expect(sanitizeNodeInputs({ extras: { key: 'apiKey', value: 'FAKE-PAIR-2' } }, params)).toEqual({})
            expect(sanitizeNodeInputs({ extras: { nested: { key: 'X-Custom-Auth', value: 'FAKE-PAIR-3' }, ok: 1 } }, params)).toEqual({
                extras: { ok: 1 }
            })
            expect(sanitizeNodeInputs({ headers: { key: 'Accept', value: 'text/plain' } }, params)).toEqual({
                headers: { key: 'Accept', value: 'text/plain' }
            })
        })

        it('drops credential URLs from public display fields and keeps ordinary ones', () => {
            const display = publicChatbotDisplayConfig({
                titleAvatarSrc: 'https://img.example/a.png?refresh_token=FAKE-DISP-URL',
                welcomeMessage: 'https://example.com/help?q=hours&page=1',
                botMessage: { avatarSrc: 'https://img.example/b.png?X-Amz-Signature=FAKE-DISP-SIG' }
            })
            expect(display).toEqual({ welcomeMessage: 'https://example.com/help?q=hours&page=1', botMessage: {} })
        })
    })

    describe('encoded JSON and URL parameter parts', () => {
        const params = [
            { name: 'dblEnc', type: 'string' },
            { name: 'extras', type: 'json' },
            { name: 'callbackUrl', type: 'string' },
            { name: 'extraHeaders', type: 'string' }
        ] as any
        const twice = (v: unknown) => JSON.stringify(JSON.stringify(v))
        const thrice = (v: unknown) => JSON.stringify(twice(v))

        it('scrubs double- and triple-encoded JSON at the top level and re-encodes it the same way', () => {
            const result = sanitizeNodeInputs({ dblEnc: twice({ apiKey: 'FAKE-DBL-1', ok: 1 }) }, params)
            expect(result.dblEnc).toBe(twice({ ok: 1 }))
            const triple = sanitizeNodeInputs({ dblEnc: thrice({ apiKey: 'FAKE-TRI-1', ok: 2 }) }, params)
            expect(triple.dblEnc).toBe(thrice({ ok: 2 }))
            expect(JSON.stringify([result, triple])).not.toContain('FAKE-')
        })

        it('scrubs double-encoded JSON nested in a kept value and in headers', () => {
            const result = sanitizeNodeInputs(
                {
                    extras: { cfg: twice({ apiKey: 'FAKE-DBL-2', region: 'r1' }), list: ['x', twice({ secret: 'FAKE-DBL-3' })] },
                    extraHeaders: twice({ 'X-Custom-Auth': 'FAKE-DBL-4', 'X-Trace': 't1' })
                },
                params
            )
            expect(result.extras).toEqual({ cfg: twice({ region: 'r1' }), list: ['x', twice({})] })
            expect(JSON.parse(JSON.parse(result.extraHeaders as string))).toEqual({ 'X-Trace': 't1' })
            expect(JSON.stringify(result)).not.toContain('FAKE-')
        })

        it('drops JSON encoded more than three times and keeps plain JSON string literals', () => {
            const quad = JSON.stringify(thrice({ apiKey: 'FAKE-QUAD-1' }))
            expect(sanitizeNodeInputs({ dblEnc: quad }, params)).toEqual({})
            expect(sanitizeNodeInputs({ dblEnc: '"hello"' }, params)).toEqual({ dblEnc: '"hello"' })
        })

        it('drops double-encoded JSON from public display fields', () => {
            const saved = {
                title: twice({ apiKey: 'FAKE-DBL-DISP-1' }),
                welcomeMessage: 'Hello',
                starterPrompts: [{ prompt: twice({ apiKey: 'FAKE-DBL-DISP-2' }) }, { prompt: 'Plain question' }],
                botMessage: { textColor: twice({ u: 'https://user:pw@example.com/x' }) }
            }
            const display = publicChatbotDisplayConfig(saved)
            expect(display).toEqual({ welcomeMessage: 'Hello', starterPrompts: [{ prompt: 'Plain question' }], botMessage: {} })
            const summary = publicChatflowSummary({ id: 'f1', isPublic: true, chatbotConfig: JSON.stringify(saved) })
            expect(summary.chatbotConfig).not.toContain('FAKE-')
            expect(summary.chatbotConfig).not.toContain('user:pw@')
        })

        it.each([
            'access_token',
            'client_secret',
            'X-Amz-Signature',
            'apikey',
            'subscriptionKey',
            'userPassword',
            'X-Goog-Credential',
            'id_token',
            'refresh_token',
            'APIKey',
            'sig',
            'pwd',
            'user.passwd',
            'Auth'
        ])('drops a URL whose parameter %s names a credential', (name) => {
            expect(sanitizeNodeInputs({ callbackUrl: `https://example.com/cb?${name}=FAKE-PARAM` }, params)).toEqual({})
        })

        it.each(['author', 'keywords', 'monkeyId', 'page', 'q', 'signal', 'tokenizer'])(
            'keeps a URL whose parameter %s is ordinary',
            (name) => {
                const callbackUrl = `https://example.com/cb?${name}=7`
                expect(sanitizeNodeInputs({ callbackUrl }, params)).toEqual({ callbackUrl })
            }
        )
    })

    it('keeps a prompt that mentions Bearer but drops a real bearer token', () => {
        expect(looksLikeSecretValue('Send it as Bearer x in the header')).toBe(false)
        expect(looksLikeSecretValue('Bearer abcdefghijABCDEFGHIJ0123')).toBe(true)
        const params = [{ name: 'systemMessage', type: 'string' }] as any
        expect(sanitizeNodeInputs({ systemMessage: 'Explain Bearer x auth' }, params)).toEqual({ systemMessage: 'Explain Bearer x auth' })
    })
})

describe('declared credential names and nested headers', () => {
    const declared = (inputs: Record<string, unknown>) =>
        sanitizeNodeInputs(inputs, Object.keys(inputs).map((name) => ({ name, type: 'string' })) as any)

    it('drops a declared myApiKey holding a plain 40-char hex value', () => {
        expect(declared({ myApiKey: '0123456789abcdef0123456789abcdef01234567', temperature: 0.1 })).toEqual({ temperature: 0.1 })
    })

    it('keeps accessTokenUrl and tokenUrl holding plain URLs', () => {
        const urls = { accessTokenUrl: 'https://auth.example.com/oauth/token', tokenUrl: 'http://example.com/token?scope=read' }
        expect(declared(urls)).toEqual(urls)
    })

    it('drops token-named fields whose URL carries credentials', () => {
        expect(
            declared({
                tokenUrl: 'https://example.com/token?access_token=abc',
                refreshTokenUrl: 'https://user:pw@example.com/token',
                accessTokenUrl: 'https://example.com/cb#sig=abc',
                accessToken: 'plain'
            })
        ).toEqual({})
    })

    it('keeps token-count settings, sessionId, projectKey and a bare key', () => {
        const kept = {
            maxTokens: 100,
            maxOutputTokens: 50,
            maxTokenLimit: 10,
            max_tokens_to_sample: 5,
            sessionId: 's1',
            projectKey: 'P',
            key: 'P-1'
        }
        expect(declared(kept)).toEqual(kept)
    })

    it('drops credential headers in per-node and nested shapes of json template inputs', () => {
        const params = [
            { name: 'config', type: 'json' },
            { name: 'apiKey', type: 'string' }
        ] as any
        expect(
            sanitizeNodeInputs(
                {
                    apiKey: 'plain-value',
                    config: {
                        headers: { node_0: { 'X-Custom-Auth': 'plain', Accept: 'a' } },
                        something: {
                            headers: JSON.stringify([
                                { key: 'X-Custom-Auth', value: 'plain' },
                                { key: 'Accept', value: 'a' }
                            ])
                        }
                    }
                },
                params
            )
        ).toEqual({
            config: {
                headers: { node_0: { Accept: 'a' } },
                something: { headers: JSON.stringify([{ key: 'Accept', value: 'a' }]) }
            }
        })
    })
})

describe('public display config shapes', () => {
    it('keeps scalars only as primitives and nested objects only with their listed keys', () => {
        expect(
            publicChatbotDisplayConfig({
                title: { extra: 'x' },
                welcomeMessage: 'Hi',
                fontSize: 14,
                generateNewSession: true,
                backgroundColor: ['#fff'],
                botMessage: { textColor: '#000', avatarSrc: { nested: 1 }, extra: 'x' },
                textInput: 'not-an-object'
            })
        ).toEqual({ welcomeMessage: 'Hi', fontSize: 14, generateNewSession: true, botMessage: { textColor: '#000' } })
    })

    it('returns starterPrompts as an array of { prompt } from array or index-keyed shapes', () => {
        expect(
            publicChatbotDisplayConfig({
                starterPrompts: { 0: { prompt: 'One', extra: 'x' }, 1: { prompt: { a: 1 } }, 2: 'bare', 3: { prompt: 'Two' } }
            })
        ).toEqual({ starterPrompts: [{ prompt: 'One' }, { prompt: 'Two' }] })
        expect(publicChatbotDisplayConfig({ starterPrompts: [{ prompt: 'A' }, null, { leak: 'x' }] })).toEqual({
            starterPrompts: [{ prompt: 'A' }]
        })
        expect(publicChatbotDisplayConfig({ starterPrompts: 'One' })).toEqual({})
    })
})

describe('credential-bearing URLs in node inputs', () => {
    const params = [
        { name: 'url', type: 'string' },
        { name: 'note', type: 'string' },
        { name: 'config', type: 'json' },
        { name: 'authorization', type: 'string' },
        { name: 'auth', type: 'string' },
        { name: 'site', type: 'string' }
    ] as any

    it('drops userinfo and credential-parameter URLs at any depth and auth-named inputs, keeping plain URLs', () => {
        expect(
            sanitizeNodeInputs(
                {
                    url: 'https://example.com/hook?api_key=abc',
                    note: 'https://user:pw@example.com/x',
                    config: {
                        a: 'https://example.com/cb#access_token=abc',
                        b: ['https://example.com/s?sig=1', 'https://example.com/p?page=2'],
                        c: 'https://example.com/x?Signature=1&client_secret=2'
                    },
                    authorization: 'plain',
                    auth: 'plain',
                    site: 'https://example.com/docs?q=token'
                },
                params
            )
        ).toEqual({ config: { b: ['https://example.com/p?page=2'] }, site: 'https://example.com/docs?q=token' })
    })
})

describe('pair shape, fragments and decoded userinfo', () => {
    const params = [
        { name: 'callbackUrl', type: 'string' },
        { name: 'requestsGetHeaders', type: 'json' },
        { name: 'extras', type: 'json' }
    ] as any

    it('treats key as an ordinary name unless the object is exactly { key, value }', () => {
        expect(sanitizeNodeInputs({ requestsGetHeaders: { key: 'FAKE-KEYNAME-1', Accept: 'json' } }, params)).toEqual({
            requestsGetHeaders: { Accept: 'json' }
        })
        expect(sanitizeNodeInputs({ extras: { key: 'FAKE-KEYNAME-2', mode: 'm' } }, params)).toEqual({ extras: { mode: 'm' } })
        expect(sanitizeNodeInputs({ requestsGetHeaders: [{ key: 'Accept', value: 'json' }] }, params)).toEqual({
            requestsGetHeaders: [{ key: 'Accept', value: 'json' }]
        })
        expect(sanitizeNodeInputs({ requestsGetHeaders: [{ key: 'X-Custom-Auth', value: 'FAKE-PAIR', enabled: true }] }, params)).toEqual({
            requestsGetHeaders: []
        })
    })

    it.each([
        'https://example.com/cb#/path?apikey=FAKE-FRAG-1',
        'https://example.com/cb#/p?x=1&token=FAKE-FRAG-2',
        'https://example.com/cb#a=1&sig=FAKE-FRAG-3',
        'https://user%3AFAKE-UI@example.com/x',
        '//user:FAKE-UI-2@example.com/x',
        'see https://user:FAKE-UI-3@example.com/x for details',
        'https://example.com/x;token=FAKE-MATRIX-1'
    ])('drops %s on templates and public display', (url) => {
        expect(sanitizeNodeInputs({ callbackUrl: url }, params)).toEqual({})
        expect(publicChatbotDisplayConfig({ welcomeMessage: url })).toEqual({})
    })

    it('keeps a fragment route with ordinary parameters', () => {
        const callbackUrl = 'https://example.com/app#/search?q=bread&page=3'
        expect(sanitizeNodeInputs({ callbackUrl }, params)).toEqual({ callbackUrl })
    })
})

describe('encoding fuzz: no fake secret marker survives any wrapper, carrier and location', () => {
    const MARK = 'FAKEMARKQ7'
    const carriers: Record<string, unknown> = {
        'bare URL with userinfo': `https://user:${MARK}@example.com/x`,
        'query param': `https://example.com/x?api_key=${MARK}`,
        'fragment param': `https://example.com/x#a=1&access_token=${MARK}`,
        'fragment ?query': `https://example.com/x#/cb?token=${MARK}`,
        'apiKey field': { apiKey: MARK, ok: 1 },
        'header pair': { key: 'X-Custom-Auth', value: MARK },
        'header map key': { 'X-Api-Key': MARK, Accept: 'a' }
    }
    const twice = (v: string) => JSON.stringify(JSON.stringify(v))
    const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
    const wrappers: Record<string, (v: unknown) => unknown> = {
        none: (v) => v,
        'JSON 1x': (v) => JSON.stringify(v),
        'JSON 2x': (v) => JSON.stringify(JSON.stringify(v)),
        'JSON 3x': (v) => JSON.stringify(JSON.stringify(JSON.stringify(v))),
        'percent-encoded': (v) => encodeURIComponent(asText(v)),
        'percent inside JSON': (v) => JSON.stringify(encodeURIComponent(asText(v))),
        'JSON inside percent': (v) => encodeURIComponent(twice(asText(v))),
        'array element': (v) => [v],
        'object value': (v) => ({ wrap: v })
    }
    const params = [
        { name: 'note', type: 'string' },
        { name: 'extras', type: 'json' },
        { name: 'requestsGetHeaders', type: 'json' }
    ] as any
    const displayOf = (field: string, v: unknown): Record<string, unknown> => {
        if (field === 'starter prompt') return { starterPrompts: [{ prompt: v }] }
        if (field === 'textColor') return { botMessage: { textColor: v } }
        return { [field]: v }
    }
    const locations: Record<string, (v: unknown) => unknown> = {
        'template top level': (v) => sanitizeNodeInputs({ note: v, extras: v }, params),
        'template nested': (v) => sanitizeNodeInputs({ extras: { a: { b: v }, list: [1, v] } }, params),
        'template *headers': (v) => sanitizeNodeInputs({ requestsGetHeaders: v, extras: { proxyHeaders: v } }, params),
        'public title': (v) => publicChatbotDisplayConfig(displayOf('title', v)),
        'public welcomeMessage': (v) => publicChatbotDisplayConfig(displayOf('welcomeMessage', v)),
        'public starter prompt': (v) => publicChatbotDisplayConfig(displayOf('starter prompt', v)),
        'public textColor': (v) => publicChatbotDisplayConfig(displayOf('textColor', v)),
        'public chatflow summary': (v) =>
            publicChatflowSummary({
                id: 'f1',
                isPublic: true,
                chatbotConfig: JSON.stringify({
                    title: v,
                    welcomeMessage: v,
                    starterPrompts: [{ prompt: v }],
                    botMessage: { textColor: v }
                })
            })
    }
    const cases: [string, string, string][] = []
    for (const w of Object.keys(wrappers))
        for (const c of Object.keys(carriers)) for (const l of Object.keys(locations)) cases.push([w, c, l])

    it.each(cases)('%s × %s × %s', (w, c, l) => {
        const out = JSON.stringify(locations[l](wrappers[w](carriers[c])))
        expect(out).not.toContain(MARK)
        expect(decodeURIComponent(out.replace(/%(?![0-9a-f]{2})/gi, '%25'))).not.toContain(MARK)
    })

    it('keeps harmless values through the same wrappers on template inputs', () => {
        const harmless = { url: 'https://example.com/search?q=cakes&page=2#results', mode: 'fast' }
        for (const w of ['none', 'JSON 1x', 'JSON 2x', 'JSON 3x', 'array element', 'object value']) {
            const wrapped = wrappers[w](harmless)
            expect(sanitizeNodeInputs({ extras: wrapped }, params)).toEqual({ extras: wrapped })
        }
        expect(publicChatbotDisplayConfig({ title: 'Ask about 50% off', welcomeMessage: 'See https://example.com/help?q=1' })).toEqual({
            title: 'Ask about 50% off',
            welcomeMessage: 'See https://example.com/help?q=1'
        })
    })
})
