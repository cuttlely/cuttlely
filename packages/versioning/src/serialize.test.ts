import fs from 'fs'
import path from 'path'
import {
    canonicalJson,
    deserializeFlow,
    flowFolderName,
    flowSlug,
    hiddenSecretsIn,
    isSecretKey,
    isSecretValue,
    isServerPathInput,
    serializeFlow,
    FlowData,
    FlowFiles
} from './serialize'
import { SECRET_PLACEHOLDER } from './redact'

const ROOT = path.resolve(__dirname, '..', '..', '..')

function listJson(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry)
        if (fs.statSync(full).isDirectory()) return listJson(full)
        return entry.endsWith('.json') ? [full] : []
    })
}

function flowFromFile(file: string): FlowData | null {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const flow = typeof parsed.flowData === 'string' ? JSON.parse(parsed.flowData) : parsed.flowData || parsed
    return Array.isArray(flow?.nodes) ? flow : null
}

// Round trip drops only UI state (selected, dragging) and sorts edges by id.
function normalize(flow: FlowData): unknown {
    const strip = (value: any): any => {
        if (Array.isArray(value)) return value.map(strip)
        if (value && typeof value === 'object') {
            const out: Record<string, any> = {}
            for (const key of Object.keys(value).sort()) {
                if (value[key] === undefined) continue
                out[key] = strip(value[key])
            }
            return out
        }
        return value
    }
    const nodes = (flow.nodes || []).map((node: any) => {
        const { selected: _selected, dragging: _dragging, resizing: _resizing, ...rest } = node
        const data = { ...(rest.data || {}) }
        delete data.selected
        return { ...rest, data }
    })
    const edges = (flow.edges || [])
        .map((edge: any) => {
            const { selected: _selected, ...rest } = edge
            return rest
        })
        .sort((a: any, b: any) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
    return strip({ ...flow, nodes, edges })
}

const meta = { id: '0b5c3a1e-1111-2222-3333-444455556666', name: 'Sales Desk', type: 'HARNESS' }

function sampleFlow(): FlowData {
    return {
        nodes: [
            {
                id: 'harnessChief_0',
                type: 'customNode',
                position: { x: 10, y: 20 },
                positionAbsolute: { x: 10, y: 20 },
                width: 300,
                height: 500,
                selected: true,
                dragging: false,
                data: {
                    id: 'harnessChief_0',
                    name: 'harnessChief',
                    label: 'Harness Prime',
                    version: 1,
                    type: 'HarnessChief',
                    category: 'Harness',
                    baseClasses: ['HarnessChief'],
                    inputParams: [{ name: 'instructions', type: 'string', rows: 6 }],
                    inputAnchors: [],
                    outputAnchors: [],
                    inputs: { instructions: 'Route data questions to the analyst.\nKeep answers short.' },
                    outputs: {},
                    selected: true
                }
            },
            {
                id: 'chatOpenAI_0',
                type: 'customNode',
                position: { x: 400, y: 20 },
                width: 300,
                height: 600,
                data: {
                    id: 'chatOpenAI_0',
                    name: 'chatOpenAI',
                    label: 'ChatOpenAI',
                    version: 8,
                    type: 'ChatOpenAI',
                    category: 'Chat Models',
                    credential: 'cred-uuid-1',
                    filePath: '/home/someone/cuttlely/node_modules/chatOpenAI.js',
                    inputParams: [
                        { name: 'modelName', type: 'asyncOptions' },
                        { name: 'basePath', type: 'string' },
                        { name: 'proxyApiKey', type: 'password' },
                        { name: 'certFile', type: 'file' }
                    ],
                    inputs: {
                        modelName: 'gpt-4.1',
                        temperature: 0.2,
                        basePath: '',
                        proxyApiKey: 'not-a-real-key-value',
                        certFile: 'data:application/x-pem;base64,AAAA',
                        FLOWISE_CREDENTIAL_ID: 'cred-uuid-1',
                        odd: { $text: 'looks like a marker' }
                    },
                    outputs: {}
                }
            }
        ],
        edges: [
            { id: 'e2', source: 'chatOpenAI_0', target: 'harnessChief_0', sourceHandle: 'a', targetHandle: 'b', type: 'buttonedge' },
            { id: 'e1', source: 'x', target: 'y', selected: true }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
    }
}

const credentialRef = (id: string) => (id === 'cred-uuid-1' ? { name: 'OpenAI main', credentialName: 'openAIApi' } : undefined)
const resolveCredential = (ref: { name: string; credentialName: string }) =>
    ref.name === 'OpenAI main' && ref.credentialName === 'openAIApi' ? 'cred-uuid-local' : undefined

describe('flow file serializer', () => {
    test('writes one folder of small files with a stable layout', () => {
        const files = serializeFlow(meta, sampleFlow(), { credentialRef })
        expect(Object.keys(files).sort()).toEqual([
            'edges.json',
            'flow.json',
            'layout.json',
            'nodes/chatOpenAI_0.definition.json',
            'nodes/chatOpenAI_0.json',
            'nodes/harnessChief_0.definition.json',
            'nodes/harnessChief_0.json',
            'prompts/harnessChief_0.instructions.md'
        ])
        expect(files['prompts/harnessChief_0.instructions.md']).toBe('Route data questions to the analyst.\nKeep answers short.')
        const flow = JSON.parse(files['flow.json'])
        expect(flow.formatVersion).toBe(1)
        expect(flow.models).toEqual([{ component: 'chatOpenAI', model: 'gpt-4.1', node: 'chatOpenAI_0' }])
        expect(flow.credentials).toEqual([{ credentialName: 'openAIApi', name: 'OpenAI main' }])
        for (const content of Object.values(files)) {
            if (!content.startsWith('{') && !content.startsWith('[')) continue
            expect(content.endsWith('\n')).toBe(true)
            expect(canonicalJson(JSON.parse(content))).toBe(content)
        }
    })

    test('never writes secrets, credential ids, server paths, or UI state', () => {
        const files = serializeFlow(meta, sampleFlow(), { credentialRef })
        const all = Object.values(files).join('\n')
        expect(all).not.toContain('not-a-real-key-value')
        expect(all).not.toContain('base64,AAAA')
        expect(all).not.toContain('cred-uuid-1')
        expect(all).not.toContain('/home/someone')
        expect(all).not.toContain('"selected"')
        expect(all).not.toContain('"dragging"')
    })

    test('an unknown credential id is written as null, never as the id', () => {
        const files = serializeFlow(meta, sampleFlow(), { credentialRef: () => undefined })
        const node = JSON.parse(files['nodes/chatOpenAI_0.json'])
        expect(node.data.credential).toEqual({ $credential: null })
        expect(Object.values(files).join('\n')).not.toContain('cred-uuid-1')
    })

    test('the same flow always gives the same bytes', () => {
        const a = serializeFlow(meta, sampleFlow(), { credentialRef })
        const shuffled = sampleFlow()
        shuffled.edges.reverse()
        const b = serializeFlow(meta, JSON.stringify(shuffled), { credentialRef })
        expect(b).toEqual(a)
    })

    test('moving a node changes only layout.json', () => {
        const before = serializeFlow(meta, sampleFlow(), { credentialRef })
        const moved = sampleFlow()
        moved.nodes[0].position = { x: 999, y: 999 }
        moved.nodes[0].positionAbsolute = { x: 999, y: 999 }
        const after = serializeFlow(meta, moved, { credentialRef })
        const changed = Object.keys(after).filter((file) => after[file] !== before[file])
        expect(changed).toEqual(['layout.json'])
    })

    test('a credential kept in inputs is stored the way the canvas saves it', () => {
        // The canvas moves inputs.FLOWISE_CREDENTIAL_ID to data.credential when it saves.
        // A flow made through the API can still have it in inputs. Both give the same files.
        const api = sampleFlow()
        const canvas = sampleFlow()
        delete canvas.nodes[1].data.inputs.FLOWISE_CREDENTIAL_ID
        expect(serializeFlow(meta, api, { credentialRef })).toEqual(serializeFlow(meta, canvas, { credentialRef }))
        const onlyInputs = sampleFlow()
        delete onlyInputs.nodes[1].data.credential
        expect(serializeFlow(meta, onlyInputs, { credentialRef })).toEqual(serializeFlow(meta, canvas, { credentialRef }))
    })

    test('a different id in inputs is kept apart', () => {
        const odd = sampleFlow()
        odd.nodes[1].data.inputs.FLOWISE_CREDENTIAL_ID = 'cred-uuid-2'
        const node = JSON.parse(serializeFlow(meta, odd, { credentialRef })['nodes/chatOpenAI_0.json'])
        expect(node.data.credential).toEqual({ $credential: { name: 'OpenAI main', credentialName: 'openAIApi' } })
        expect(node.data.inputs.FLOWISE_CREDENTIAL_ID).toEqual({ $credential: null })
    })

    test('a prompt edit changes only that prompt file', () => {
        const before = serializeFlow(meta, sampleFlow(), { credentialRef })
        const edited = sampleFlow()
        edited.nodes[0].data.inputs.instructions = 'Route data questions to the analyst.\nKeep answers very short.'
        const after = serializeFlow(meta, edited, { credentialRef })
        const changed = Object.keys(after).filter((file) => after[file] !== before[file])
        expect(changed).toEqual(['prompts/harnessChief_0.instructions.md'])
    })

    test('round trip maps credentials by name and carries secret inputs over from the current flow', () => {
        const original = sampleFlow()
        const files = serializeFlow(meta, original, { credentialRef })
        const result = deserializeFlow(files, { resolveCredential, current: original })
        const node = result.flowData.nodes.find((item) => item.id === 'chatOpenAI_0')!
        expect(node.data.credential).toBe('cred-uuid-local')
        // Stored the way the canvas saves it: in data.credential only.
        expect(node.data.inputs.FLOWISE_CREDENTIAL_ID).toBeUndefined()
        expect(node.data.inputs.proxyApiKey).toBe('not-a-real-key-value')
        expect(node.data.inputs.certFile).toBe('data:application/x-pem;base64,AAAA')
        expect(node.data.inputs.odd).toEqual({ $text: 'looks like a marker' })
        expect(node.data.filePath).toBe('/home/someone/cuttlely/node_modules/chatOpenAI.js')
        expect(result.missingCredentials).toEqual([])
        expect(result.meta).toEqual({ id: meta.id, name: 'Sales Desk', type: 'HARNESS' })
    })

    test('without a current flow, secrets stay empty and missing credentials are listed', () => {
        const files = serializeFlow(meta, sampleFlow(), { credentialRef })
        const result = deserializeFlow(files, { resolveCredential: () => undefined })
        const node = result.flowData.nodes.find((item) => item.id === 'chatOpenAI_0')!
        expect(node.data.credential).toBe('')
        expect(node.data.inputs.proxyApiKey).toBeUndefined()
        expect(result.missingCredentials).toEqual([{ name: 'OpenAI main', credentialName: 'openAIApi' }])
    })

    test('rejects a format version it cannot read', () => {
        const files: FlowFiles = serializeFlow(meta, sampleFlow(), { credentialRef })
        const flow = JSON.parse(files['flow.json'])
        flow.formatVersion = 99
        files['flow.json'] = canonicalJson(flow)
        expect(() => deserializeFlow(files)).toThrow(/format version 99/)
    })

    test('reports a missing file by name', () => {
        const files = serializeFlow(meta, sampleFlow(), { credentialRef })
        delete files['prompts/harnessChief_0.instructions.md']
        expect(() => deserializeFlow(files)).toThrow('prompts/harnessChief_0.instructions.md')
    })

    test('folder names are readable and unique per flow', () => {
        expect(flowSlug('  Sales Desk: Q4 / West!  ')).toBe('sales-desk-q4-west')
        expect(flowSlug('***')).toBe('flow')
        expect(flowFolderName(meta)).toBe('sales-desk--0b5c3a1e')
    })

    test('a slug trims separator runs without keeping a dash at either end', () => {
        expect(flowSlug('')).toBe('flow')
        expect(flowSlug('-')).toBe('flow')
        expect(flowSlug('---')).toBe('flow')
        expect(flowSlug('-'.repeat(200))).toBe('flow')
        expect(flowSlug('   ')).toBe('flow')
        expect(flowSlug(' ' + 'a'.repeat(39) + '-' + 'b')).toBe('a'.repeat(39))
        expect(flowSlug('a'.repeat(40) + '---tail')).toBe('a'.repeat(40))
        expect(flowSlug('Hello---World')).toBe('hello-world')
    })

    test('a node id that would collide with a definition file gets its own name', () => {
        const flow: FlowData = {
            nodes: [
                { id: 'a', data: { id: 'a', name: 'n', extraDef: 1, inputs: {} } },
                { id: 'a.definition', data: { id: 'a.definition', name: 'n', extraDef: 2, inputs: {} } }
            ],
            edges: []
        }
        const files = serializeFlow(meta, flow)
        expect(normalize(deserializeFlow(files).flowData)).toEqual(normalize(flow))
    })

    const templates = [
        ...listJson(path.join(ROOT, 'packages', 'server', 'marketplaces')),
        ...listJson(path.join(ROOT, 'samples', 'chatflows')),
        ...listJson(path.join(ROOT, 'samples', 'harnesses')).filter((file) => file.endsWith('.canvas.json')),
        ...listJson(path.join(ROOT, 'samples', 'etl'))
    ]
        .map((file) => ({ file, flow: flowFromFile(file) }))
        .filter((item): item is { file: string; flow: FlowData } => Boolean(item.flow))

    test('finds the shipped templates and samples', () => {
        expect(templates.length).toBeGreaterThan(20)
    })

    test.each(templates.map((item) => [path.relative(ROOT, item.file), item.flow] as const))(
        'round trip keeps %s intact',
        (_name, flow) => {
            const files = serializeFlow(meta, flow)
            const back = deserializeFlow(files, { current: flow })
            expect(normalize(back.flowData)).toEqual(normalize(flow))
            expect(serializeFlow(meta, back.flowData)).toEqual(files)
        }
    )

    describe('structured inputs, nested credentials, and server paths', () => {
        const AGENT_CRED = '5f0c9a52-7d1e-4b8e-9a39-3c2f6f1d0a11'
        const TOOL_CRED = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
        const refs: Record<string, { name: string; credentialName: string }> = {
            [AGENT_CRED]: { name: 'OpenAI main', credentialName: 'openAIApi' },
            [TOOL_CRED]: { name: 'Search key', credentialName: 'braveSearchApi' }
        }
        const nestedRef = (id: string) => refs[id]
        const nestedResolve = (ref: { name: string; credentialName: string }) =>
            ref.name === 'OpenAI main' ? 'prod-openai-id' : ref.name === 'Search key' ? 'prod-search-id' : undefined

        function structuredFlow(): FlowData {
            return {
                nodes: [
                    {
                        id: 'agentAgentflow_0',
                        type: 'agentFlow',
                        position: { x: 0, y: 0 },
                        data: {
                            id: 'agentAgentflow_0',
                            name: 'agentAgentflow',
                            label: 'Agent',
                            inputParams: [{ name: 'agentModelConfig', type: 'json' }],
                            inputs: {
                                agentModel: 'chatOpenAI',
                                agentModelConfig: { FLOWISE_CREDENTIAL_ID: AGENT_CRED, modelName: 'gpt-4.1', maxTokens: 512 },
                                agentTools: [{ agentSelectedTool: 'braveSearch', agentSelectedToolConfig: { credential: TOOL_CRED } }]
                            }
                        }
                    },
                    {
                        id: 'apiChain_0',
                        type: 'customNode',
                        position: { x: 0, y: 0 },
                        data: {
                            id: 'apiChain_0',
                            name: 'postApiChain',
                            label: 'POST API Chain',
                            inputParams: [{ name: 'headers', type: 'json' }],
                            inputs: {
                                headers: '{"Authorization":"Bearer not-a-real-token-123456","X-Team":"west"}',
                                baseOptions: { 'X-Api-Key': 'not-a-real-api-key', timeout: 30 },
                                url: 'https://api.example.com/v1',
                                pastedKey: 'Bearer not-a-real-token-abcdefgh'
                            }
                        }
                    },
                    {
                        id: 'faiss_0',
                        type: 'customNode',
                        position: { x: 0, y: 0 },
                        data: {
                            id: 'faiss_0',
                            name: 'faiss',
                            label: 'Faiss',
                            inputParams: [{ name: 'basePath', type: 'string' }],
                            inputs: { basePath: '/srv/cuttlely/faiss-index', topK: 4 }
                        }
                    },
                    {
                        id: 'chatLocalAI_0',
                        type: 'customNode',
                        position: { x: 0, y: 0 },
                        data: {
                            id: 'chatLocalAI_0',
                            name: 'chatLocalAI',
                            label: 'LocalAI',
                            inputs: { basePath: 'http://localhost:8080/v1', modelName: 'llama' }
                        }
                    }
                ],
                edges: []
            }
        }

        test('nothing secret-shaped, no credential id, and no server path is written', () => {
            const files = serializeFlow(meta, structuredFlow(), { credentialRef: nestedRef })
            const all = Object.values(files).join('\n')
            for (const text of ['not-a-real-token', 'not-a-real-api-key', AGENT_CRED, TOOL_CRED, '/srv/cuttlely']) {
                expect(all).not.toContain(text)
            }
            const agent = JSON.parse(files['nodes/agentAgentflow_0.json']).data.inputs
            expect(agent.agentModelConfig).toEqual({
                FLOWISE_CREDENTIAL_ID: { $credential: { name: 'OpenAI main', credentialName: 'openAIApi' } },
                maxTokens: 512,
                modelName: 'gpt-4.1'
            })
            expect(agent.agentTools[0].agentSelectedToolConfig.credential).toEqual({
                $credential: { name: 'Search key', credentialName: 'braveSearchApi' }
            })
            const api = JSON.parse(files['nodes/apiChain_0.json']).data.inputs
            expect(api.headers).toEqual({ $json: { Authorization: { $secret: true }, 'X-Team': 'west' } })
            expect(api.baseOptions).toEqual({ 'X-Api-Key': { $secret: true }, timeout: 30 })
            expect(api.pastedKey).toEqual({ $secret: true })
            expect(api.url).toBe('https://api.example.com/v1')
            expect(JSON.parse(files['nodes/faiss_0.json']).data.inputs).toEqual({ topK: 4 })
            expect(JSON.parse(files['nodes/chatLocalAI_0.json']).data.inputs.basePath).toBe('http://localhost:8080/v1')
            expect(JSON.parse(files['flow.json']).credentials).toEqual([
                { credentialName: 'braveSearchApi', name: 'Search key' },
                { credentialName: 'openAIApi', name: 'OpenAI main' }
            ])
        })

        test('round trip restores secrets and paths from the current flow and maps nested credentials by name', () => {
            const original = structuredFlow()
            const files = serializeFlow(meta, original, { credentialRef: nestedRef })
            const same = deserializeFlow(files, {
                resolveCredential: (ref) => Object.keys(refs).find((id) => refs[id].name === ref.name),
                current: original
            })
            expect(normalize(same.flowData)).toEqual(normalize(original))

            const prod = deserializeFlow(files, { resolveCredential: nestedResolve, current: original })
            const agent = prod.flowData.nodes[0].data.inputs
            expect(agent.agentModelConfig.FLOWISE_CREDENTIAL_ID).toBe('prod-openai-id')
            expect(agent.agentTools[0].agentSelectedToolConfig.credential).toBe('prod-search-id')
        })

        test('with no current flow, secrets and paths come back empty and missing nested credentials are listed', () => {
            const files = serializeFlow(meta, structuredFlow(), { credentialRef: nestedRef })
            const result = deserializeFlow(files, { resolveCredential: () => undefined })
            const api = result.flowData.nodes[1].data.inputs
            expect(JSON.parse(api.headers)).toEqual({ Authorization: '', 'X-Team': 'west' })
            expect(api.baseOptions['X-Api-Key']).toBe('')
            expect(api.pastedKey).toBe('')
            expect(result.flowData.nodes[2].data.inputs.basePath).toBeUndefined()
            expect(result.missingCredentials).toEqual(
                expect.arrayContaining([
                    { name: 'OpenAI main', credentialName: 'openAIApi' },
                    { name: 'Search key', credentialName: 'braveSearchApi' }
                ])
            )
        })

        test('an edited header shows up while the secret stays out', () => {
            const before = serializeFlow(meta, structuredFlow(), { credentialRef: nestedRef })
            const edited = structuredFlow()
            edited.nodes[1].data.inputs.headers = '{"Authorization":"Bearer a-different-fake-token-999","X-Team":"east"}'
            const after = serializeFlow(meta, edited, { credentialRef: nestedRef })
            const changed = Object.keys(after).filter((file) => after[file] !== before[file])
            expect(changed).toEqual(['nodes/apiChain_0.json'])
            expect(after['nodes/apiChain_0.json']).toContain('"east"')
            expect(after['nodes/apiChain_0.json']).not.toContain('a-different-fake-token')
        })

        test('secret keys, secret values, and server paths are recognized without catching ordinary settings', () => {
            for (const key of [
                'Authorization',
                'x-api-key',
                'apiKey',
                'OPENAI_API_KEY',
                'clientSecret',
                'access_token',
                'password',
                'Cookie'
            ]) {
                expect(isSecretKey(key)).toBe(true)
            }
            for (const key of ['maxTokens', 'max_tokens', 'tokenLimit', 'secretName', 'keyName', 'modelName', 'url']) {
                expect(isSecretKey(key)).toBe(false)
            }
            expect(isSecretValue('Bearer abcdefgh12345')).toBe(true)
            // Built at run time so the repo secret scan does not flag a fixture.
            expect(isSecretValue(['postgres', '://user:pw', '@db.example.com/app'].join(''))).toBe(true)
            expect(isSecretValue('https://api.example.com/v1')).toBe(false)
            expect(isSecretValue('Token budget is small')).toBe(false)
            expect(isServerPathInput('folderPath', '/data/docs')).toBe(true)
            expect(isServerPathInput('basePath', 'https://llm.example.com')).toBe(false)
            expect(isServerPathInput('modelName', '/not/a/path/input')).toBe(false)
        })
    })
})

describe('hiding secret-looking text', () => {
    const key = ['sk', 'abcdEFGH1234ijklMNOP5678'].join('-')
    const bearer = ['Bearer', ['eyJhbGciOi', 'JIUzI1NiJ9.abc123def456'].join('')].join(' ')
    const node = (inputs: Record<string, unknown>) => ({
        id: 'tool_0',
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: {
            id: 'tool_0',
            name: 'requestsGet',
            label: 'Requests Get',
            inputs,
            inputParams: [
                { name: 'description', label: 'Description', type: 'string' },
                { name: 'headers', label: 'Headers', type: 'json' },
                { name: 'url', label: 'URL', type: 'string' }
            ]
        }
    })

    test('a one-line input, JSON text and a URL are written without the secret, and flow.json says where', () => {
        const flow = {
            nodes: [
                node({
                    description: `Call it with ${key} please`,
                    headers: JSON.stringify({ 'X-Note': `send ${bearer} along` }),
                    url: 'https://api.example.com/v1/items?page=2'
                })
            ],
            edges: []
        }
        const files = serializeFlow({ id: 'f1', name: 'Tools' }, flow)
        const all = Object.values(files).join('\n')
        expect(all).not.toContain(key)
        expect(all).not.toContain(bearer.split(' ')[1])
        const stored = JSON.parse(files['nodes/tool_0.json']).data.inputs
        expect(stored.description).toBe(`Call it with ${SECRET_PLACEHOLDER} please`)
        expect(stored.headers).toEqual({ $json: { 'X-Note': `send Bearer ${SECRET_PLACEHOLDER} along` } })
        expect(stored.url).toBe('https://api.example.com/v1/items?page=2')
        expect(JSON.parse(files['flow.json']).hidden).toEqual([
            { node: 'tool_0', label: 'Requests Get', input: 'description', inputLabel: 'Description', count: 1 },
            { node: 'tool_0', label: 'Requests Get', input: 'headers', inputLabel: 'Headers', count: 1 }
        ])
        // The flow passed in is not changed.
        expect(flow.nodes[0].data.inputs.description).toContain(key)
    })

    test('reading the version back keeps the placeholder and lists the hidden values', () => {
        const flow = { nodes: [node({ description: `Call it with ${key} please` })], edges: [] }
        const files = serializeFlow({ id: 'f1', name: 'Tools' }, flow)
        const result = deserializeFlow(files, { current: flow })
        expect(result.flowData.nodes[0].data.inputs.description).toBe(`Call it with ${SECRET_PLACEHOLDER} please`)
        expect(result.hiddenSecrets).toEqual([
            { node: 'tool_0', label: 'Requests Get', input: 'description', inputLabel: 'Description', count: 1 }
        ])
    })

    test('a placeholder already in an input is listed again, so a restored version keeps its warning', () => {
        const flow = { nodes: [node({ description: `Call it with ${SECRET_PLACEHOLDER} please` })], edges: [] }
        const files = serializeFlow({ id: 'f1', name: 'Tools' }, flow)
        expect(JSON.parse(files['nodes/tool_0.json']).data.inputs.description).toBe(`Call it with ${SECRET_PLACEHOLDER} please`)
        expect(JSON.parse(files['flow.json']).hidden).toEqual([
            { node: 'tool_0', label: 'Requests Get', input: 'description', inputLabel: 'Description', count: 1 }
        ])
    })

    test('ordinary text writes no hidden list, and an older flow.json without one reads as none', () => {
        const files = serializeFlow({ id: 'f1', name: 'Tools' }, { nodes: [node({ description: 'Fetch the item list.' })], edges: [] })
        expect(JSON.parse(files['flow.json']).hidden).toBeUndefined()
        expect(hiddenSecretsIn(files)).toEqual([])
        expect(hiddenSecretsIn({ 'flow.json': '{"formatVersion":1}' })).toEqual([])
        expect(hiddenSecretsIn({})).toEqual([])
    })
})
