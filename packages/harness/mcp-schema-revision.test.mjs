import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-mcp-revision-'))
process.env.CUTTLELY_DATA_DIR = data
process.env.CUTTLELY_HERMES_HOME = path.join(data, 'hermes')
delete process.env.HERMES_HOME
const { compileProfile } = await import('./profile.mjs')

test('compiled MCP bridge revision tracks tool definitions, not model or answer settings', () => {
    const record = {
        name: 'schema-revision-fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
        chief: { model: { nodeName: 'chatOpenAI', inputs: { modelName: 'example' } } },
        specialists: [
            {
                name: 'data',
                shell: true,
                instructions: 'Answer from tools.',
                modules: [{ nodeId: 'echo', nodeName: 'echoNode', inputs: { value: 'one' } }],
                mcpServers: [
                    {
                        nodeId: 'pg',
                        nodeName: 'postgreSQLMCP',
                        inputs: {
                            pinnedQueries: [
                                {
                                    id: 'monthly',
                                    name: 'monthly',
                                    sql: 'select :month_count',
                                    params: [{ name: 'month_count', type: 'int8' }]
                                }
                            ]
                        }
                    }
                ]
            }
        ]
    }
    const revision = (value) => {
        const compiled = compileProfile(value)
        const profile = compiled.roster.specialists[0].profileName
        const config = YAML.parse(fs.readFileSync(path.join(data, 'hermes/profiles', profile, 'config.yaml'), 'utf8'))
        const bridge = config.mcp_servers.data
        assert.equal(Object.keys(config.mcp_servers)[0], 'data', 'Public MCP namespace stays unchanged')
        const index = bridge.args.indexOf('--tool-revision')
        assert.ok(index >= 0, 'Compiled bridge must version its tool schema cache identity')
        assert.match(bridge.args[index + 1], /^[a-f0-9]{64}$/)
        return bridge.args[index + 1]
    }
    try {
        const original = revision(record)
        assert.equal(revision(record), original)
        const answerEdit = structuredClone(record)
        answerEdit.specialists[0].instructions = 'Be concise.'
        answerEdit.specialists[0].model = { nodeName: 'chatOpenAI', inputs: { modelName: 'different' } }
        answerEdit.specialists[0].capacityWaitSeconds = 30
        assert.equal(revision(answerEdit), original)
        const schemaEdit = structuredClone(record)
        schemaEdit.specialists[0].mcpServers[0].inputs.pinnedQueries[0].params[0].name = 'start_date'
        assert.notEqual(revision(schemaEdit), original)
        const rename = structuredClone(record)
        rename.specialists[0].mcpServers[0].inputs.pinnedQueries[0].name = 'monthly_explicit'
        assert.notEqual(revision(rename), original)
        const moduleEdit = structuredClone(record)
        moduleEdit.specialists[0].modules[0].inputs.value = 'two'
        assert.notEqual(revision(moduleEdit), original)
    } finally {
        fs.rmSync(data, { recursive: true, force: true })
    }
})
