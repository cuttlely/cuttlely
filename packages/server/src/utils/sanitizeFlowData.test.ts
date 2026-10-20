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
            chatbotConfig: JSON.stringify({ title: 'Bot', overrideConfig: { temperature: 0.1 } })
        })
    })
})

describe('public config follow-up rules', () => {
    it('drops credential headers from overrideConfig in array and object form', () => {
        const run = (headers: unknown) =>
            JSON.parse(
                publicChatflowSummary({
                    id: 'f',
                    chatbotConfig: JSON.stringify({ overrideConfig: { temperature: 0.2, headers } })
                }).chatbotConfig as string
            ).overrideConfig
        expect(
            run([
                { key: 'X-Custom-Auth', value: 'plain' },
                { key: 'Accept', value: 'application/json' }
            ])
        ).toEqual({ temperature: 0.2, headers: [{ key: 'Accept', value: 'application/json' }] })
        expect(run({ 'X-Custom-Auth': 'plain', Accept: 'text/plain' })).toEqual({ temperature: 0.2, headers: { Accept: 'text/plain' } })
        expect(run(JSON.stringify({ 'X-Custom-Auth': 'plain', Accept: 'text/plain' }))).toEqual({
            temperature: 0.2,
            headers: JSON.stringify({ Accept: 'text/plain' })
        })
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

    const summaryOverride = (overrideConfig: unknown) =>
        JSON.parse(publicChatflowSummary({ id: 'f', chatbotConfig: JSON.stringify({ overrideConfig }) }).chatbotConfig as string)
            .overrideConfig

    it('drops credential headers in per-node and nested shapes of overrideConfig', () => {
        expect(
            summaryOverride({
                headers: {
                    httpAgentflow_0: { 'X-Custom-Auth': 'plain', Accept: 'a' },
                    http_1: JSON.stringify({ Cookie: 'c', 'X-Ok': 'b' })
                },
                something: {
                    headers: { 'X-Custom-Auth': 'plain', Accept: 'a' },
                    deeper: {
                        Headers: [
                            { key: 'X-Custom-Auth', value: 'plain' },
                            { key: 'Accept', value: 'a' }
                        ]
                    }
                }
            })
        ).toEqual({
            headers: { httpAgentflow_0: { Accept: 'a' }, http_1: JSON.stringify({ 'X-Ok': 'b' }) },
            something: { headers: { Accept: 'a' }, deeper: { Headers: [{ key: 'Accept', value: 'a' }] } }
        })
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
