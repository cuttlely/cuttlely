import { generateExportFlowData } from './genericHelper'
import { credentialRebindError, rebindCredentialBundle, rebindFlowCredentials } from './credentialRebind'

const SOURCE_ID = 'cred-source-should-not-travel'
const DEST_ID = 'cred-dest-already-here'
const POSTGRES_SOURCE = 'pg-source-should-not-travel'
const POSTGRES_DEST = 'pg-dest-already-here'

const credentials = [
    { id: SOURCE_ID, name: 'Bakery model', credentialName: 'openAIApi' },
    { id: POSTGRES_SOURCE, name: 'Bakery warehouse', credentialName: 'PostgresUrl' }
]

function flow() {
    return {
        nodes: [
            {
                id: 'chatOpenAI_0',
                data: {
                    id: 'chatOpenAI_0',
                    label: 'OpenAI',
                    name: 'chatOpenAI',
                    type: 'ChatOpenAI',
                    credential: SOURCE_ID,
                    inputParams: [
                        { name: 'modelName', type: 'asyncOptions' },
                        { name: 'apiKey', type: 'password' }
                    ],
                    inputAnchors: [],
                    inputs: {
                        modelName: 'gpt-5.6-luna',
                        apiKey: 'not-a-real-password',
                        FLOWISE_CREDENTIAL_ID: SOURCE_ID
                    },
                    outputAnchors: [],
                    outputs: {},
                    selected: false
                }
            },
            {
                id: 'postgreSQLMCP_0',
                data: {
                    id: 'postgreSQLMCP_0',
                    label: 'PostgreSQL MCP',
                    name: 'postgreSQLMCP',
                    type: 'PostgreSQL MCP Tool',
                    credential: POSTGRES_SOURCE,
                    inputParams: [
                        { name: 'mcpActions', type: 'asyncMultiOptions' },
                        { name: 'analystRules', type: 'string' },
                        { name: 'password', type: 'password' }
                    ],
                    inputAnchors: [],
                    inputs: {
                        mcpActions: '["query"]',
                        analystRules: 'Use monthly_sales.',
                        password: 'db-password-must-not-travel'
                    },
                    outputAnchors: [],
                    outputs: {},
                    selected: false
                }
            }
        ],
        edges: [{ id: 'e1' }]
    }
}

describe('credential export and import', () => {
    it('keeps QUERY and other non-secret inputs, and names credentials without ids or secrets', () => {
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(flow())), ['chatOpenAI', 'postgreSQLMCP'], credentials)
        const text = JSON.stringify(exported)
        expect(exported.nodes[1].data.inputs.mcpActions).toBe('["query"]')
        expect(exported.nodes[1].data.inputs.analystRules).toBe('Use monthly_sales.')
        expect(exported.nodes[0].data.inputs.modelName).toBe('gpt-5.6-luna')
        expect(exported.nodes[0].data.inputs.apiKey).toBeUndefined()
        expect(exported.nodes[1].data.inputs.password).toBeUndefined()
        expect(text).not.toContain(SOURCE_ID)
        expect(text).not.toContain(POSTGRES_SOURCE)
        expect(text).not.toContain('FLOWISE_CREDENTIAL_ID')
        expect(text).not.toContain('not-a-real-password')
        expect(text).not.toContain('db-password-must-not-travel')
        expect(exported.nodes[0].data.credential).toEqual({ $credential: { name: 'Bakery model', credentialName: 'openAIApi' } })
        expect(exported.nodes[1].data.credential).toEqual({ $credential: { name: 'Bakery warehouse', credentialName: 'PostgresUrl' } })
    })

    it('rebinds a credential that already exists on the destination by name and type', () => {
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(flow())), ['chatOpenAI', 'postgreSQLMCP'], credentials)
        const destination = [
            { id: DEST_ID, name: 'Bakery model', credentialName: 'openAIApi' },
            { id: POSTGRES_DEST, name: 'Bakery warehouse', credentialName: 'PostgresUrl' }
        ]
        const rebound = rebindFlowCredentials(exported, destination)
        expect(credentialRebindError(rebound)).toBe('')
        expect(rebound.flow.nodes[0].data.credential).toBe(DEST_ID)
        expect(rebound.flow.nodes[0].data.inputs.FLOWISE_CREDENTIAL_ID).toBe(DEST_ID)
        expect(rebound.flow.nodes[1].data.credential).toBe(POSTGRES_DEST)
        expect(rebound.flow.nodes[1].data.inputs.mcpActions).toBe('["query"]')
        expect(JSON.stringify(rebound.flow)).not.toContain(SOURCE_ID)
    })

    it('stops when the destination has no matching credential, and does not invent one', () => {
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(flow())), ['chatOpenAI', 'postgreSQLMCP'], credentials)
        const rebound = rebindFlowCredentials(exported, [{ id: DEST_ID, name: 'Bakery model', credentialName: 'openAIApi' }])
        expect(rebound.flow.nodes[1].data.credential).toBe('')
        expect(credentialRebindError(rebound)).toContain('Bakery warehouse')
        expect(credentialRebindError(rebound)).toContain('did not create one')
        expect(JSON.stringify(rebound.flow)).not.toContain('postgres://')
    })

    it('stops when more than one destination credential has that name and type', () => {
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(flow())), ['chatOpenAI', 'postgreSQLMCP'], credentials)
        const rebound = rebindFlowCredentials(exported, [
            { id: 'a', name: 'Bakery model', credentialName: 'openAIApi' },
            { id: 'b', name: 'Bakery model', credentialName: 'openAIApi' },
            { id: POSTGRES_DEST, name: 'Bakery warehouse', credentialName: 'PostgresUrl' }
        ])
        expect(rebound.flow.nodes[0].data.credential).toBe('')
        expect(credentialRebindError(rebound)).toContain('2 credentials named "Bakery model"')
    })

    it('names a credential the export server no longer has, and tells the importer to export again', () => {
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(flow())), ['chatOpenAI', 'postgreSQLMCP'], [])
        expect(exported.nodes[0].data.credential).toEqual({ $credential: null })
        expect(JSON.stringify(exported)).not.toContain(SOURCE_ID)
        const rebound = rebindFlowCredentials(exported, credentials)
        expect(credentialRebindError(rebound)).toContain('Export it again')
    })

    it('keeps an empty credential slot empty and still imports it', () => {
        const saved = {
            nodes: [
                {
                    id: 'sqlAgent_0',
                    data: {
                        id: 'sqlAgent_0',
                        label: 'SQL Agent',
                        name: 'sqlAgent',
                        type: 'SQLAgent',
                        credential: '',
                        inputParams: [{ name: 'agentModel', type: 'json' }],
                        inputAnchors: [],
                        inputs: {
                            agentModel: { credential: '', modelName: 'gpt-5.6-luna', FLOWISE_CREDENTIAL_ID: '' }
                        },
                        outputAnchors: [],
                        outputs: {},
                        selected: false
                    }
                }
            ],
            edges: []
        }
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(saved)), ['sqlAgent'], credentials)
        expect(exported.nodes[0].data.inputs.agentModel.credential).toBe('')
        expect(exported.nodes[0].data.inputs.agentModel.modelName).toBe('gpt-5.6-luna')
        expect(JSON.stringify(exported)).not.toContain('$credential')
        const rebound = rebindFlowCredentials(exported, [])
        expect(credentialRebindError(rebound)).toBe('')
        expect(rebound.flow.nodes[0].data.inputs.agentModel.credential).toBe('')
    })

    it('rebinds a named credential in an Import All bundle and stops when one is missing', () => {
        const exported = generateExportFlowData(JSON.parse(JSON.stringify(flow())), ['chatOpenAI', 'postgreSQLMCP'], credentials)
        const bundle = {
            ChatFlow: [{ id: 'flow-1', name: 'bakery', flowData: JSON.stringify(exported), type: 'CHATFLOW' }],
            Variable: [{ id: 'v1', name: 'shop', value: 'old town' }]
        }
        const ready = rebindCredentialBundle(bundle, [
            { id: DEST_ID, name: 'Bakery model', credentialName: 'openAIApi' },
            { id: POSTGRES_DEST, name: 'Bakery warehouse', credentialName: 'PostgresUrl' }
        ])
        expect(ready.message).toBe('')
        const canvas = JSON.parse(ready.bundle.ChatFlow[0].flowData)
        expect(canvas.nodes[0].data.credential).toBe(DEST_ID)
        expect(canvas.nodes[1].data.credential).toBe(POSTGRES_DEST)
        expect(canvas.nodes[1].data.inputs.mcpActions).toBe('["query"]')
        expect(ready.bundle.Variable).toEqual(bundle.Variable)
        const missing = rebindCredentialBundle(bundle, [{ id: DEST_ID, name: 'Bakery model', credentialName: 'openAIApi' }])
        expect(missing.message).toContain('Bakery warehouse')
        expect(missing.message).toContain('did not create one')
    })

    it('leaves an older export that has no credential mark alone', () => {
        const older = { nodes: [{ data: { name: 'chatOpenAI', inputs: { modelName: 'gpt-5.6-luna' } } }], edges: [] }
        const rebound = rebindFlowCredentials(older, [])
        expect(credentialRebindError(rebound)).toBe('')
        expect(rebound.flow.nodes[0].data.inputs.modelName).toBe('gpt-5.6-luna')
    })
})
