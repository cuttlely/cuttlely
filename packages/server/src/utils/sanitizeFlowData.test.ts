import fs from 'fs'
import path from 'path'

import {
    buildTemplateFlow,
    isChatflowKeyProtected,
    publicChatbotDisplayConfig,
    publicChatflowSummary,
    rebuildHttpUrl,
    sanitizeNodeInputs
} from './sanitizeFlowData'

const MARKER = 'FAKE_MARKER_'

const promptParams = [
    { name: 'prompt', type: 'string' },
    { name: 'systemMessage', type: 'string' },
    { name: 'systemMessagePrompt', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'label', type: 'string' },
    { name: 'placeholder', type: 'string' },
    { name: 'toolName', type: 'string' },
    { name: 'agentName', type: 'string' },
    { name: 'toolDescription', type: 'string' },
    { name: 'requestsGetName', type: 'string' }
]

const schemaParams = [
    ...promptParams,
    { name: 'temperature', type: 'number' },
    { name: 'streaming', type: 'boolean' },
    {
        name: 'reasoningEffort',
        type: 'options',
        options: [
            { label: 'Low', name: 'low' },
            { label: 'High', name: 'high' }
        ]
    },
    {
        name: 'stops',
        type: 'multiOptions',
        options: [
            { label: 'A', name: 'alpha' },
            { label: 'B', name: 'beta' }
        ]
    },
    { name: 'modelName', type: 'asyncOptions' },
    { name: 'basepath', type: 'string' },
    { name: 'basePath', type: 'string' },
    { name: 'config', type: 'json' },
    { name: 'snippet', type: 'code' },
    { name: 'secretField', type: 'password' },
    { name: 'upload', type: 'file' },
    { name: 'directory', type: 'folder' },
    { name: 'when', type: 'date' },
    { name: 'grid', type: 'datagrid' },
    { name: 'relations', type: 'asyncMultiOptions' },
    { name: 'rows', type: 'array' },
    { name: 'headers', type: 'string' },
    { name: 'requestsGetHeaders', type: 'json' },
    { name: 'note', type: 'string' },
    { name: 'credentialId', type: 'string' }
]

const percentEncode = (value: string) =>
    Array.from(value)
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join('')

const mulberry32 = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const secretShapes = (marker: string) => [
    `sk-${marker}`,
    `pk-${marker}`,
    `ghp_${marker}`,
    `xoxb-${marker}`,
    `\u0455\u043a-${marker}`,
    `https://cdn.example/a?utm_apikey=${marker}`,
    `user:${marker}@files.example`,
    `{not json sk-${marker}`,
    `{"wrapped":"${marker}","prefix":"sk-abc"}`,
    percentEncode(`sk-${marker}`),
    JSON.stringify(`sk-${marker}`),
    JSON.stringify(JSON.stringify(`pk-${marker}`)),
    percentEncode(JSON.stringify(`ghp_${marker}`)),
    `preamble ${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'} ${marker}`
]

describe('template inputs', () => {
    const harmless = {
        prompt: 'Hello "world" @ café, 10% off',
        systemMessage: 'こんにちは。See the help page.',
        systemMessagePrompt: 'Translate {input_language} to {output_language}.',
        description: 'Looks up the bakery hours',
        label: 'Greeting',
        placeholder: 'Ask a question',
        toolName: 'hours',
        agentName: 'baker',
        toolDescription: 'Reads the hours sheet',
        requestsGetName: 'getHours',
        temperature: 0.2,
        streaming: false,
        reasoningEffort: 'low',
        stops: '["alpha","beta"]',
        modelName: 'gpt-4.1-mini',
        basepath: 'https://api.example.com/v1?utm_apikey=ignored#frag',
        basePath: 'https://models.example/root'
    }

    it('keeps harmless prompts, typed values, listed options, and a rebuilt base path', () => {
        const { inputs, dropped } = sanitizeNodeInputs(harmless, schemaParams as any)
        expect(dropped).toEqual([])
        expect(inputs).toEqual({
            ...harmless,
            basepath: 'https://api.example.com/v1',
            basePath: 'https://models.example/root'
        })
    })

    it('keeps a canvas link on an anchor and leaves every other undeclared value out', () => {
        const { inputs, dropped } = sanitizeNodeInputs(
            {
                model: '{{chatOpenAI_0.data.instance}}',
                tools: ['{{tool_0.data.instance}}', '{{tool_1.data.instance}}'],
                openAIApiKey: `sk-${MARKER}ORPHAN`,
                note: 'not declared here'
            },
            [],
            [{ name: 'model' }, { name: 'tools' }],
            new Set(['chatOpenAI_0', 'tool_0', 'tool_1'])
        )
        expect(inputs).toEqual({
            model: '{{chatOpenAI_0.data.instance}}',
            tools: ['{{tool_0.data.instance}}', '{{tool_1.data.instance}}']
        })
        expect(dropped.sort()).toEqual(['note', 'openAIApiKey'])
        expect(JSON.stringify(inputs)).not.toContain(MARKER)
    })

    it('leaves a canvas link out when the anchor value is not only that link', () => {
        const { inputs, dropped } = sanitizeNodeInputs(
            { model: `{{chatOpenAI_0.data.instance}} sk-${MARKER}LINK`, tools: ['{{tool_0.data.instance}}', `sk-${MARKER}TOOL`] },
            [],
            [{ name: 'model' }, { name: 'tools' }],
            new Set(['chatOpenAI_0', 'tool_0'])
        )
        expect(inputs).toEqual({})
        expect(dropped).toEqual(['model', 'tools'])
    })

    it('keeps a canvas link only when it names a node in the same flow', () => {
        const { inputs, dropped } = sanitizeNodeInputs(
            {
                model: '{{chatOpenAI_0.data.instance}}',
                tools: ['{{tool_0.data.instance}}'],
                missing: '{{missingNode_0.data.instance}}',
                shaped: `{{sk-${MARKER}NODE_0.data.instance}}`,
                nested: '{{chatOpenAI_0.data.instance.secret}}'
            },
            [],
            [{ name: 'model' }, { name: 'tools' }, { name: 'missing' }, { name: 'shaped' }, { name: 'nested' }],
            new Set(['chatOpenAI_0', 'tool_0'])
        )
        expect(inputs).toEqual({
            model: '{{chatOpenAI_0.data.instance}}',
            tools: ['{{tool_0.data.instance}}']
        })
        expect(dropped.sort()).toEqual(['missing', 'nested', 'shaped'])
        expect(JSON.stringify(inputs)).not.toContain(MARKER)
        const flow = buildTemplateFlow(
            {
                nodes: [
                    {
                        id: 'llmChain_0',
                        data: {
                            name: 'llmChain',
                            inputs: {
                                model: '{{chatOpenAI_0.data.instance}}',
                                gone: '{{missingNode_3.data.instance}}'
                            }
                        }
                    },
                    { id: 'chatOpenAI_0', data: { name: 'chatOpenAI', inputs: {} } }
                ],
                edges: []
            },
            {
                llmChain: { name: 'llmChain', label: 'Chain', inputAnchors: [{ name: 'model' }, { name: 'gone' }] },
                chatOpenAI: { name: 'chatOpenAI', label: 'OpenAI' }
            }
        )
        const saved = (flow.nodes[0] as { data: { inputs: Record<string, unknown> } }).data.inputs
        expect(saved.model).toBe('{{chatOpenAI_0.data.instance}}')
        expect(saved.gone).toBeUndefined()
        expect(JSON.stringify(flow)).not.toContain(MARKER)
    })

    it('drops a kept string whole when the normalized text has //, an @ between non-spaces, a scheme-like word, or a token prefix', () => {
        const cases = [
            `Use sk-${MARKER}ONE`,
            `prefix pk-${MARKER}TWO`,
            `ghp_${MARKER}THREE`,
            `xoxp-${MARKER}FOUR`,
            `\u0455\u043a-${MARKER}FIVE`,
            `See https://example.com/cb?utm_apikey=${MARKER}SIX`,
            `See https://example.com/cb#${MARKER}SEVEN`,
            `user:${MARKER}EIGHT@files.example`,
            `//user:${MARKER}SLASH@host`,
            `//cdn.example/a?utm_apikey=${MARKER}QUERY`,
            `//cdn.example/a#${MARKER}HASH`,
            `https:example.com/a?x=${MARKER}SCHEME`,
            `path/user:${MARKER}PATH@files.example`,
            `hello a@b ${MARKER}AT`,
            percentEncode(`sk-${MARKER}NINE`),
            percentEncode(`//user:${MARKER}ENC@host`),
            JSON.stringify(`pk-${MARKER}TEN`),
            `{"hidden":"sk-${MARKER}ELEVEN"}`,
            `{not json sk-${MARKER}TWELVE`,
            `note ${'aB3dE9fG1hJ2kL4mN6pQ8rS0tU5vW7xY'} ${MARKER}RUN`
        ]
        for (const prompt of cases) {
            const { inputs } = sanitizeNodeInputs({ prompt, temperature: 0.1 }, schemaParams as any)
            expect(JSON.stringify(inputs)).not.toContain(MARKER)
            expect(inputs.prompt).toBeUndefined()
            expect(inputs.temperature).toBe(0.1)
        }
    })

    it('drops a prompt when a control, encoded break, NBSP, or zero-width character sits before a token prefix', () => {
        const prompts = [
            `Use\nsk-${MARKER}A`,
            `Use%0Ask-${MARKER}B`,
            `Use\u200bsk-${MARKER}C`,
            `Use\tsk-${MARKER}D`,
            `Use\rsk-${MARKER}E`,
            `Use\u00a0sk-${MARKER}F`,
            `Use\u0001sk-${MARKER}G`,
            `Use\u007fsk-${MARKER}H`,
            `Use\u2028sk-${MARKER}I`,
            `Use\ufeffsk-${MARKER}J`
        ]
        for (const prompt of prompts) {
            const { inputs, dropped } = sanitizeNodeInputs({ prompt, temperature: 0.2 }, schemaParams as any)
            expect(inputs.prompt).toBeUndefined()
            expect(inputs.temperature).toBe(0.2)
            expect(dropped).toContain('prompt')
            expect(JSON.stringify(inputs)).not.toContain(MARKER)
        }
    })

    it('keeps a harmless prompt that spans more than one line', () => {
        const prompts = [
            'Hello "world" @ café, 10% off\nSee the help page.',
            'Line one.\r\nLine two.\tThanks for asking.',
            'Ask\u00a0about the hours today.'
        ]
        for (const prompt of prompts) {
            const { inputs, dropped } = sanitizeNodeInputs({ prompt }, schemaParams as any)
            expect(inputs.prompt).toBe(prompt)
            expect(dropped).toEqual([])
        }
    })

    it('drops the wrong JavaScript type for every kept kind', () => {
        const wrong = {
            temperature: `sk-${MARKER}NUM`,
            streaming: `sk-${MARKER}BOOL`,
            reasoningEffort: `sk-${MARKER}OPT`,
            stops: `sk-${MARKER}MULTI`,
            modelName: { name: `sk-${MARKER}ASYNC` },
            prompt: { text: `sk-${MARKER}PROMPT` },
            basepath: `user:${MARKER}URL@files.example`
        }
        const { inputs } = sanitizeNodeInputs(wrong, schemaParams as any)
        expect(inputs).toEqual({})
        expect(JSON.stringify(inputs)).not.toContain(MARKER)
    })

    it('keeps a plain UUID async option and drops another long random option', () => {
        const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
        const upper = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890'
        const { inputs } = sanitizeNodeInputs({ modelName: uuid, otherName: upper, noisy: 'aB3dE9fG1hJ2kL4mN6pQ8rS0tU5vW7xY' }, [
            { name: 'modelName', type: 'asyncOptions' },
            { name: 'otherName', type: 'asyncOptions' },
            { name: 'noisy', type: 'asyncOptions' }
        ] as any)
        expect(inputs.modelName).toBe(uuid)
        expect(inputs.otherName).toBe(upper)
        expect(inputs.noisy).toBeUndefined()
        const prompt = sanitizeNodeInputs({ prompt: uuid }, [{ name: 'prompt', type: 'string' }] as any)
        expect(prompt.inputs.prompt).toBeUndefined()
    })

    it('drops option values that are not in the declared list, including a listed name of the wrong type', () => {
        const { inputs } = sanitizeNodeInputs({ reasoningEffort: 'medium', stops: '["alpha","nope"]' }, schemaParams as any)
        expect(inputs).toEqual({})
        const typed = sanitizeNodeInputs({ reasoningEffort: 'low' }, [
            { name: 'reasoningEffort', type: 'options', options: [{ name: 1 }] }
        ] as any)
        expect(typed.inputs).toEqual({})
    })

    it('fills every non-allowlisted input and every wrong-typed value with secret-shaped text and keeps none of the marker', () => {
        const blockedNames = [
            'config',
            'snippet',
            'secretField',
            'upload',
            'directory',
            'when',
            'grid',
            'relations',
            'rows',
            'headers',
            'requestsGetHeaders',
            'note',
            'credentialId'
        ]
        const rng = mulberry32(131)
        for (let trial = 0; trial < 40; trial += 1) {
            const marker = `${MARKER}${trial}_`
            const shapes = secretShapes(marker)
            const pick = () => shapes[Math.floor(rng() * shapes.length)]
            const inputs: Record<string, unknown> = {
                prompt: 'Hello "world" @ café, 10% off',
                systemMessage: 'こんにちは',
                temperature: 0.4,
                streaming: true,
                reasoningEffort: 'high',
                modelName: 'gpt-4.1-mini',
                basepath: 'https://api.example.com/v1'
            }
            for (const name of blockedNames) inputs[name] = pick()
            inputs.undeclared = pick()
            inputs.temperatureWrong = pick()
            inputs.nested = { inner: [pick(), { again: pick() }] }
            const params = [...schemaParams, { name: 'temperatureWrong', type: 'number' }, { name: 'nested', type: 'json' }]
            const flow = buildTemplateFlow(
                {
                    nodes: [
                        {
                            id: `n-${trial}`,
                            data: {
                                id: `n-${trial}`,
                                label: 'Model',
                                name: 'chatOpenAI',
                                credential: pick(),
                                inputParams: params,
                                inputAnchors: [{ name: 'model' }],
                                inputs: { ...inputs, model: '{{chatOpenAI_0.data.instance}}', prompt: pick() }
                            }
                        },
                        { id: 'chatOpenAI_0', data: { id: 'chatOpenAI_0', name: 'chatOpenAI', inputs: {} } }
                    ],
                    edges: [{ id: 'e1' }]
                },
                {
                    chatOpenAI: {
                        name: 'chatOpenAI',
                        label: 'Model',
                        inputParams: params,
                        inputAnchors: [{ name: 'model' }]
                    }
                }
            )
            expect(JSON.stringify(flow)).not.toContain(marker)
            expect(JSON.stringify(flow)).not.toContain(MARKER)
            const kept = (flow.nodes[0] as { data: { inputs: Record<string, unknown> } }).data.inputs
            expect(kept.systemMessage).toBe('こんにちは')
            expect(kept.temperature).toBe(0.4)
            expect(kept.streaming).toBe(true)
            expect(kept.reasoningEffort).toBe('high')
            expect(kept.modelName).toBe('gpt-4.1-mini')
            expect(kept.basepath).toBe('https://api.example.com/v1')
            expect(kept.model).toBe('{{chatOpenAI_0.data.instance}}')
            expect(kept.prompt).toBeUndefined()
        }
    })

    it('keeps no marker in any decoded field when every input type is given a wrong value', () => {
        const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
        const avatar = 'https://cdn.example/images/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.png'
        const decodeString = (value: string, depth: number): unknown => {
            let current = value
            for (let layer = 0; layer < 8; layer += 1) {
                let decoded = current
                try {
                    decoded = decodeURIComponent(current)
                } catch {
                    decoded = current
                }
                try {
                    const parsed = JSON.parse(decoded)
                    if (typeof parsed === 'string') {
                        current = parsed
                        continue
                    }
                    if (parsed && typeof parsed === 'object') return fullyDecode(parsed, depth + 1)
                } catch {
                    // not JSON
                }
                if (decoded === current) return current
                current = decoded
            }
            return current
        }
        const fullyDecode = (value: unknown, depth = 0): unknown => {
            if (depth > 12) return value
            if (typeof value === 'string') return decodeString(value, depth)
            if (Array.isArray(value)) return value.map((item) => fullyDecode(item, depth + 1))
            if (value && typeof value === 'object') {
                const out: Record<string, unknown> = {}
                for (const [key, child] of Object.entries(value)) {
                    const decodedKey = fullyDecode(key, depth + 1)
                    out[typeof decodedKey === 'string' ? decodedKey : key] = fullyDecode(child, depth + 1)
                }
                return out
            }
            return value
        }
        const expectNoMarker = (value: unknown) => {
            const texts: string[] = []
            const walk = (node: unknown) => {
                if (typeof node === 'string') {
                    texts.push(node)
                    return
                }
                if (Array.isArray(node)) {
                    node.forEach(walk)
                    return
                }
                if (node && typeof node === 'object') {
                    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
                        texts.push(key)
                        walk(child)
                    }
                }
            }
            walk(fullyDecode(value))
            for (const text of texts) expect(text).not.toContain(MARKER)
        }
        const componentParams = [
            { name: 'temperature', type: 'number' },
            { name: 'streaming', type: 'boolean' },
            {
                name: 'reasoningEffort',
                type: 'options',
                options: [
                    { label: 'Low', name: 'low' },
                    { label: 'High', name: 'high' }
                ]
            },
            {
                name: 'stops',
                type: 'multiOptions',
                options: [
                    { label: 'A', name: 'alpha' },
                    { label: 'B', name: 'beta' }
                ]
            },
            { name: 'modelName', type: 'asyncOptions' },
            { name: 'otherModel', type: 'asyncOptions' },
            { name: 'prompt', type: 'string', placeholder: 'Ask' },
            { name: 'systemMessage', type: 'string' },
            { name: 'description', type: 'string' },
            { name: 'label', type: 'string' },
            { name: 'placeholder', type: 'string' },
            { name: 'toolName', type: 'string' },
            { name: 'agentName', type: 'string' },
            { name: 'toolDescription', type: 'string' },
            { name: 'requestsGetName', type: 'string' },
            { name: 'basePath', type: 'string' },
            { name: 'baseURL', type: 'string' },
            { name: 'config', type: 'json' },
            { name: 'snippet', type: 'code' },
            { name: 'secretField', type: 'password' },
            { name: 'upload', type: 'file' },
            { name: 'directory', type: 'folder' },
            { name: 'credential', type: 'credential' },
            { name: 'note', type: 'string' }
        ]
        const rng = mulberry32(262)
        for (let trial = 0; trial < 40; trial += 1) {
            const marker = `${MARKER}${trial}_`
            const shapes = [
                `//user:${marker}@host`,
                `//cdn.example/a?utm_apikey=${marker}`,
                `//cdn.example/a#${marker}`,
                `https:example.com/a?x=${marker}`,
                `path/user:${marker}@files.example`
            ]
            const carry = (shape: string) => {
                const forms = [shape, percentEncode(shape), JSON.stringify(shape), percentEncode(JSON.stringify(shape))]
                return forms[Math.floor(rng() * forms.length)]
            }
            const carried = shapes.map((shape) => carry(shape))
            // Each kind gets a JavaScript type it does not accept. The five shapes are also whole values.
            const inputs: Record<string, unknown> = {
                prompt: 'Hello "world"',
                systemMessage: 'a @ b',
                description: 'こんにちは',
                label: '10% off',
                modelName: uuid,
                model: '{{cache_0.data.instance}}',
                missing: '{{missingNode_3.data.instance}}',
                shaped: `{{sk-${marker}NODE_0.data.instance}}`,
                temperature: trial % 2 === 0 ? carried[0] : { n: carried[0] },
                streaming: trial % 2 === 0 ? carried[1] : [carried[1]],
                reasoningEffort: { picked: carried[2] },
                stops: { picked: carried[3] },
                otherModel: trial % 2 === 0 ? { id: carried[4] } : [carried[4]],
                placeholder: { text: carried[0] },
                toolName: [carried[1]],
                agentName: { name: carried[2] },
                toolDescription: shapes[0],
                requestsGetName: shapes[1],
                note: shapes[2],
                basePath: shapes[4],
                baseURL: trial % 2 === 0 ? { href: carried[3] } : shapes[3],
                config: trial % 2 === 0 ? carried[0] : [carried[0]],
                snippet: { body: carried[1] },
                secretField: { secret: carried[2] },
                upload: [carried[3]],
                directory: { path: carried[4] },
                credential: trial % 2 === 0 ? { id: carried[0] } : [carried[0]]
            }
            const flow = buildTemplateFlow(
                {
                    nodes: [
                        {
                            id: 'llmChain_0',
                            position: { x: 1, y: 2 },
                            data: {
                                id: 'llmChain_0',
                                name: 'llmChain',
                                label: `${marker}LABEL`,
                                description: `${marker}DESC`,
                                category: `${marker}CAT`,
                                tags: [`${marker}TAG`],
                                extraProp: `${marker}EXTRA`,
                                credential: carry(shapes[2]),
                                inputParams: componentParams.map((param) => ({ ...param, placeholder: `${marker}PLACE` })),
                                inputAnchors: [{ name: 'model' }, { name: 'missing' }, { name: 'shaped' }],
                                inputs
                            }
                        },
                        { id: 'cache_0', data: { id: 'cache_0', name: 'cache', inputs: {} } },
                        {
                            id: 'mystery_0',
                            secretNote: `${marker}NODE`,
                            data: {
                                id: 'mystery_0',
                                name: 'notRegistered',
                                label: `${marker}GHOST`,
                                description: `${marker}GHOST`,
                                category: `${marker}GHOST`,
                                tags: [`${marker}GHOST`],
                                extraProp: `${marker}GHOST`,
                                inputParams: [{ name: 'prompt', type: 'string', placeholder: `${marker}GHOST` }],
                                inputs: { prompt: shapes[0] }
                            }
                        }
                    ],
                    edges: [{ id: 'e1', source: 'llmChain_0', target: 'cache_0' }]
                },
                {
                    llmChain: {
                        name: 'llmChain',
                        label: 'Chain',
                        description: 'Runs a chain',
                        category: 'Chains',
                        tags: ['chain'],
                        inputParams: componentParams,
                        inputAnchors: [{ name: 'model' }, { name: 'missing' }, { name: 'shaped' }]
                    },
                    cache: { name: 'cache', label: 'Cache', inputParams: [], inputAnchors: [] }
                }
            )
            expectNoMarker(flow)
            const data = (flow.nodes[0] as { data: Record<string, unknown> }).data
            const kept = data.inputs as Record<string, unknown>
            expect(data.label).toBe('Chain')
            expect(data.description).toBe('Runs a chain')
            expect(data.category).toBe('Chains')
            expect(data.tags).toEqual(['chain'])
            expect(data.extraProp).toBeUndefined()
            expect(data.inputParams).toEqual(componentParams)
            expect(kept.prompt).toBe('Hello "world"')
            expect(kept.systemMessage).toBe('a @ b')
            expect(kept.description).toBe('こんにちは')
            expect(kept.label).toBe('10% off')
            expect(kept.modelName).toBe(uuid)
            expect(kept.model).toBe('{{cache_0.data.instance}}')
            expect(kept.missing).toBeUndefined()
            expect(kept.shaped).toBeUndefined()
            expect(kept.basePath).toBeUndefined()
            expect(kept.baseURL).toBe(trial % 2 === 0 ? undefined : 'https://example.com/a')
            expect(kept.toolDescription).toBeUndefined()
            expect((flow.nodes[2] as { secretNote?: unknown; data: unknown }).secretNote).toBeUndefined()
            expect((flow.nodes[2] as { data: unknown }).data).toEqual({ id: 'mystery_0', selected: false, inputs: {} })
            const display = publicChatbotDisplayConfig({
                title: 'Hello "world"',
                welcomeMessage: 'a @ b',
                errorMessage: 'こんにちは',
                textInput: { placeholder: '10% off' },
                titleAvatarSrc: avatar,
                botMessage: { avatarSrc: shapes[trial % 5] }
            })
            expect(display.titleAvatarSrc).toBe(avatar)
            expect(display.welcomeMessage).toBe('a @ b')
            expect((display.textInput as { placeholder: string }).placeholder).toBe('10% off')
            expectNoMarker(display)
        }
    })
})

describe('dropped settings report', () => {
    it('names the node, its label, and each setting that was left out', () => {
        const original = {
            nodes: [
                {
                    id: 'chatOpenAI_0',
                    position: { x: 1, y: 2 },
                    data: {
                        id: 'chatOpenAI_0',
                        label: 'OpenAI',
                        name: 'chatOpenAI',
                        credential: 'cred-1',
                        inputParams: schemaParams,
                        inputAnchors: [{ name: 'model' }],
                        inputs: {
                            prompt: 'Hello "world" @ café, 10% off',
                            temperature: 0.2,
                            secretField: `sk-${MARKER}PW`,
                            headers: `pk-${MARKER}HDR`,
                            config: { token: `ghp_${MARKER}JSON` },
                            note: 'free text',
                            model: '{{other_0.data.instance}}',
                            extra: `xoxb-${MARKER}EXTRA`
                        }
                    }
                },
                {
                    id: 'other_0',
                    data: { id: 'other_0', name: 'stickyNote', inputs: {} }
                },
                {
                    id: 'plain_0',
                    data: {
                        id: 'plain_0',
                        label: 'Note',
                        name: 'stickyNote',
                        inputParams: [{ name: 'label', type: 'string' }],
                        inputs: { label: 'Fine' }
                    }
                }
            ],
            edges: [{ id: 'e1', source: 'a', target: 'b' }]
        }
        const snapshot = JSON.parse(JSON.stringify(original))
        const flow = buildTemplateFlow(original, {
            chatOpenAI: {
                name: 'chatOpenAI',
                label: 'OpenAI',
                inputParams: schemaParams,
                inputAnchors: [{ name: 'model' }]
            },
            stickyNote: {
                name: 'stickyNote',
                label: 'Note',
                inputParams: [{ name: 'label', type: 'string' }]
            }
        })
        expect(original).toEqual(snapshot)
        expect(JSON.stringify(snapshot)).toContain(MARKER)
        expect(JSON.stringify(flow)).not.toContain(MARKER)
        expect(flow.edges).toEqual(original.edges)
        expect(flow.droppedSettings).toEqual([
            {
                nodeId: 'chatOpenAI_0',
                label: 'OpenAI',
                inputs: ['secretField', 'headers', 'config', 'note', 'extra', 'credential']
            }
        ])
        const saved = (flow.nodes[0] as { data: { inputs: Record<string, unknown>; credential?: unknown } }).data
        expect(saved.credential).toBeUndefined()
        expect(saved.inputs).toEqual({
            prompt: 'Hello "world" @ café, 10% off',
            temperature: 0.2,
            model: '{{other_0.data.instance}}'
        })
        expect((flow.nodes[2] as { data: { inputs: Record<string, unknown> } }).data.inputs).toEqual({ label: 'Fine' })
    })

    it('uses the node name when a label was not saved', () => {
        const flow = buildTemplateFlow(
            {
                nodes: [
                    {
                        id: 'n0',
                        data: {
                            name: 'customNode',
                            inputParams: [{ name: 'prompt', type: 'string' }],
                            inputs: { prompt: `sk-${MARKER}P` }
                        }
                    }
                ],
                edges: []
            },
            { customNode: { name: 'customNode', inputParams: [{ name: 'prompt', type: 'string' }] } }
        )
        expect(flow.droppedSettings).toEqual([{ nodeId: 'n0', label: 'customNode', inputs: ['prompt'] }])
    })

    it('rebuilds node text from the registered component and records an unknown component', () => {
        const flow = buildTemplateFlow(
            {
                nodes: [
                    {
                        id: 'chatOpenAI_0',
                        position: { x: 1, y: 2 },
                        data: {
                            id: 'chatOpenAI_0',
                            name: 'chatOpenAI',
                            label: `${MARKER}LABEL`,
                            description: `${MARKER}DESC`,
                            category: `${MARKER}CAT`,
                            tags: [`${MARKER}TAG`],
                            extraProp: `${MARKER}EXTRA`,
                            inputParams: [{ name: 'prompt', type: 'string', placeholder: `${MARKER}PLACE` }],
                            inputs: { prompt: 'Hello "world" @ café, 10% off' }
                        }
                    },
                    {
                        id: 'mystery_0',
                        secretNote: `${MARKER}NODE`,
                        data: {
                            id: 'mystery_0',
                            name: 'notRegistered',
                            label: `${MARKER}GHOST`,
                            description: `${MARKER}GHOST`,
                            inputParams: [{ name: 'prompt', type: 'string', placeholder: `${MARKER}GHOST` }],
                            inputs: { prompt: 'hello' }
                        }
                    }
                ],
                edges: []
            },
            {
                chatOpenAI: {
                    name: 'chatOpenAI',
                    label: 'OpenAI',
                    description: 'Chat model',
                    category: 'Chat Models',
                    tags: ['chat'],
                    inputParams: [{ name: 'prompt', type: 'string', placeholder: 'Ask' }]
                }
            }
        )
        expect(JSON.stringify(flow)).not.toContain(MARKER)
        const data = (flow.nodes[0] as { data: Record<string, unknown> }).data
        expect(data.label).toBe('OpenAI')
        expect(data.description).toBe('Chat model')
        expect(data.category).toBe('Chat Models')
        expect(data.tags).toEqual(['chat'])
        expect(data.extraProp).toBeUndefined()
        expect(data.inputParams).toEqual([{ name: 'prompt', type: 'string', placeholder: 'Ask' }])
        expect(data.inputs).toEqual({ prompt: 'Hello "world" @ café, 10% off' })
        expect((flow.nodes[1] as { secretNote?: unknown; data: unknown }).secretNote).toBeUndefined()
        expect((flow.nodes[1] as { data: unknown }).data).toEqual({ id: 'mystery_0', selected: false, inputs: {} })
        expect(flow.droppedSettings).toEqual([{ nodeId: 'mystery_0', label: 'mystery_0', inputs: ['prompt'] }])
    })
})

describe('normal save, load, and export', () => {
    it('does not run template building on chatflow save or on canvas export', () => {
        const root = path.resolve(__dirname, '..', '..', '..', '..')
        const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
        const save = read('packages/server/src/services/chatflows/index.ts')
        expect(save.includes('buildTemplateFlow')).toBe(false)
        expect(save.includes('sanitizeNodeInputs')).toBe(false)
        const exporter = read('packages/ui/src/utils/genericHelper.js')
        const exportFn = exporter.slice(exporter.indexOf('export const generateExportFlowData'))
        expect(exportFn.includes('buildTemplateFlow')).toBe(false)
        expect(exportFn.includes('sanitizeNodeInputs')).toBe(false)
        expect(exportFn.includes("type === 'password'")).toBe(true)
        const importer = read('packages/ui/src/utils/exportImport.js')
        expect(importer.includes('buildTemplateFlow')).toBe(false)
        expect(importer.includes('sanitizeNodeInputs')).toBe(false)
    })

    it('leaves the flow object a save or load would store unchanged', () => {
        const flow = {
            nodes: [
                {
                    id: 'n1',
                    data: {
                        label: 'OpenAI',
                        credential: `sk-${MARKER}SAVE`,
                        inputParams: [{ name: 'config', type: 'json' }],
                        inputs: { config: { secret: `sk-${MARKER}SAVE` }, prompt: `pk-${MARKER}SAVE` }
                    }
                }
            ],
            edges: []
        }
        const before = JSON.stringify(flow)
        buildTemplateFlow(flow)
        expect(JSON.stringify(flow)).toBe(before)
        expect(before).toContain(MARKER)
    })
})

describe('public display fields', () => {
    it('keeps welcome text with quotes, @, non-English text, and a percent', () => {
        expect(
            publicChatbotDisplayConfig({
                title: 'Hello "friend"',
                welcomeMessage: 'Welcome @ café, 10% off',
                errorMessage: 'Something went wrong',
                starterPrompts: [{ prompt: 'こんにちは' }, { prompt: 'What is fresh?' }],
                textInput: { placeholder: 'Ask "today"' },
                generateNewSession: false,
                fontSize: 16,
                backgroundColor: '#fff',
                titleBackgroundColor: '#3B81F6',
                titleTextColor: '#ffffff',
                botMessage: {
                    showAvatar: true,
                    backgroundColor: 'rgb(247, 248, 255)',
                    textColor: 'rgba(48, 50, 53, 1)',
                    avatarSrc: 'https://img.example/bot.png?utm_apikey=1#face',
                    extra: 'no'
                },
                userMessage: { backgroundColor: '#11223344', textColor: 'not-a-color' },
                chatFeedback: { status: true, email: 'owner@example.com' },
                followUpPrompts: { status: false },
                titleAvatarSrc: 'https://img.example/logo.png',
                allowedOrigins: ['https://evil.example'],
                overrideConfig: { openAIApiKey: `sk-${MARKER}PUB` }
            })
        ).toEqual({
            title: 'Hello "friend"',
            welcomeMessage: 'Welcome @ café, 10% off',
            errorMessage: 'Something went wrong',
            starterPrompts: [{ prompt: 'こんにちは' }, { prompt: 'What is fresh?' }],
            textInput: { placeholder: 'Ask "today"' },
            generateNewSession: false,
            fontSize: 16,
            backgroundColor: '#fff',
            titleBackgroundColor: '#3B81F6',
            titleTextColor: '#ffffff',
            botMessage: {
                showAvatar: true,
                backgroundColor: 'rgb(247, 248, 255)',
                textColor: 'rgba(48, 50, 53, 1)',
                avatarSrc: 'https://img.example/bot.png'
            },
            userMessage: { backgroundColor: '#11223344' },
            chatFeedback: { status: true },
            followUpPrompts: { status: false },
            titleAvatarSrc: 'https://img.example/logo.png'
        })
    })

    it('leaves out colours, flags, numbers, and image addresses that do not match', () => {
        const result = publicChatbotDisplayConfig({
            title: 12,
            welcomeMessage: { text: 'no' },
            fontSize: '16',
            generateNewSession: 'true',
            backgroundColor: 'blue',
            titleBackgroundColor: '#ffff',
            botMessage: { showAvatar: 'yes', textColor: '#12', avatarSrc: 'javascript:alert(1)' },
            titleAvatarSrc: 'https://user:pw@img.example/a.png',
            starterPrompts: 'One',
            chatFeedback: 'on'
        })
        expect(result).toEqual({})
        expect(JSON.stringify(result)).not.toContain('user:pw@')
    })

    it('writes an address back as scheme, host, and path', () => {
        expect(rebuildHttpUrl('https://img.example/a.png?utm_apikey=FAKE_MARKER_Q#x')).toBe('https://img.example/a.png')
        expect(rebuildHttpUrl('https://cdn.example:8443/a.png?x=1')).toBe('https://cdn.example/a.png')
        expect(rebuildHttpUrl('https:example.com/a?x=FAKE_MARKER_Q')).toBe('https://example.com/a')
        expect(rebuildHttpUrl('https://cdn.example/images/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.png')).toBe(
            'https://cdn.example/images/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.png'
        )
        expect(rebuildHttpUrl('https://user:pw@img.example/a.png')).toBeUndefined()
        expect(rebuildHttpUrl('//user:FAKE_MARKER_Q@host')).toBeUndefined()
        expect(rebuildHttpUrl('//cdn.example/a?utm_apikey=FAKE_MARKER_Q')).toBeUndefined()
        expect(rebuildHttpUrl('//cdn.example/a#FAKE_MARKER_Q')).toBeUndefined()
        expect(rebuildHttpUrl('path/user:FAKE_MARKER_Q@files.example')).toBeUndefined()
        expect(rebuildHttpUrl('https://cdn.example/user%3AFAKE_MARKER_Q%40host')).toBeUndefined()
        expect(rebuildHttpUrl('https://cdn.example/%ZZ')).toBeUndefined()
        expect(rebuildHttpUrl('http://files.example/logo.png')).toBe('http://files.example/logo.png')
        expect(rebuildHttpUrl('javascript:alert(1)')).toBeUndefined()
        const { inputs } = sanitizeNodeInputs(
            { basePath: 'path/user:FAKE_MARKER_Q@files.example', baseURL: 'https://models.example:9443/root?q=1#h' },
            [...schemaParams, { name: 'baseURL', type: 'string' }] as any
        )
        expect(inputs).toEqual({ baseURL: 'https://models.example/root' })
        expect(JSON.stringify(inputs)).not.toContain('FAKE_MARKER_')
        expect(
            publicChatbotDisplayConfig({
                titleAvatarSrc: 'https://cdn.example/images/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.png',
                botMessage: { avatarSrc: 'https://cdn.example:8443/images/a.png?utm_apikey=FAKE_MARKER_Q#x' }
            })
        ).toEqual({
            titleAvatarSrc: 'https://cdn.example/images/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.png',
            botMessage: { avatarSrc: 'https://cdn.example/images/a.png' }
        })
        const summary = publicChatflowSummary({
            id: 'f1',
            name: 'Bot',
            isPublic: true,
            apikeyid: '',
            chatbotConfig: JSON.stringify({
                title: 'Bot',
                titleAvatarSrc: `https://img.example/a.png?x=${MARKER}IMG`,
                allowedOrigins: ['https://no.example'],
                overrideConfig: { openAIApiKey: `sk-${MARKER}SUM` }
            })
        })
        expect(summary).toEqual({
            id: 'f1',
            name: 'Bot',
            isPublic: true,
            hasApiKey: false,
            chatbotConfig: JSON.stringify({ title: 'Bot', titleAvatarSrc: 'https://img.example/a.png' })
        })
        expect(JSON.stringify(summary)).not.toContain(MARKER)
        expect(isChatflowKeyProtected('apikey-1')).toBe(true)
        expect(isChatflowKeyProtected('')).toBe(false)
        expect(isChatflowKeyProtected(null)).toBe(false)
    })

    it('drops text that is longer than the field cap and keeps a starter list saved as an object', () => {
        const result = publicChatbotDisplayConfig({
            title: 'T'.repeat(81),
            welcomeMessage: 'Hi',
            starterPrompts: { 0: { prompt: 'A', extra: 'x' }, 1: { prompt: '' }, 2: null }
        })
        expect(result).toEqual({ welcomeMessage: 'Hi', starterPrompts: [{ prompt: 'A' }] })
    })
})
