import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { managedFilesReady } from '../packages/harness/runtime/native-files.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const sample = (name) => JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses', name + '.canvas.json'))).flowData)
const nodeNamed = (graph, name) => graph.nodes.find((node) => node.data.name === name)
function shiftCanvas(credential, packs, units) {
    const graph = sample('calculator'),
        ops = sample('ops')
    const inventory = nodeNamed(graph, 'harnessSpecialist'),
        chief = nodeNamed(graph, 'harnessChief')
    inventory.data.inputs.specialistName = 'inventory'
    inventory.data.inputs.playbooks = [
        { name: 'shift-formula', description: 'Count dispatch stock.', content: `Inventory formula: ${packs} * ${units}` }
    ]
    chief.data.inputs.instructions = 'Reconcile the inventory count, dispatch status and shift record for the current ticket.'
    nodeNamed(graph, 'chatXAI').data.credential = credential
    const operator = nodeNamed(ops, 'harnessSpecialist'),
        clerk = structuredClone(operator)
    operator.id = operator.data.id = 'specialist_operator'
    clerk.id = clerk.data.id = 'specialist_clerk'
    Object.assign(clerk.data.inputs, {
        specialistName: 'clerk',
        instructions: 'Maintain this ticket’s shift note.',
        enableFileAccess: true
    })
    const mcp = nodeNamed(ops, 'customMCP')
    graph.nodes.push(operator, clerk, mcp)
    graph.edges.push({ id: 'mcp-operator', source: mcp.id, target: operator.id, targetHandle: operator.id + '-input-attached' })
    for (const role of [operator, clerk])
        graph.edges.push({ id: role.id + '-chief', source: role.id, target: chief.id, targetHandle: chief.id + '-input-specialists' })
    return graph
}
test(
    'a saved three-specialist team reconciles a shift through both authenticated execution modes',
    {
        skip: !managedFilesReady() && process.env.CUTTLELY_TEST_NATIVE_FILES_REQUIRED !== '1' && 'requires the managed file worker',
        timeout: 120000
    },
    async (t) => {
        assert.ok(managedFilesReady())
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-team-')),
            port = await freePort()
        const name = 'shift-parity',
            modelKey = randomUUID(),
            auth = { email: 'shift@example.invalid', password: randomUUID() + 'aA1!' }
        const url = 'http://127.0.0.1:' + port
        let server
        t.after(async () => {
            try {
                await server?.stop()
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })
        server = await startServer(
            root,
            dataEnv(dir, port, {
                CUTTLELY_LOCAL_USERS: 'true',
                CUTTLELY_INITIAL_OWNER_EMAIL: auth.email,
                CUTTLELY_INITIAL_OWNER_PASSWORD: auth.password,
                CUTTLELY_HARNESS_QUEUE: 'off',
                CUTTLELY_NATIVE_PRIME_TEAMS: name,
                CUTTLELY_ANALYST: 'off',
                KRAKEN_TEAM_PROVIDER_KEY: modelKey,
                CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
                CUSTOM_MCP_PROTOCOL: 'stdio',
                CUSTOM_MCP_SECURITY_CHECK: 'true',
                CUSTOM_MCP_ALLOWED_COMMANDS: 'node',
                CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS: 'samples/ops-mcp-server.mjs'
            }),
            { preload: [path.join(root, 'scripts/fixtures/kraken-team-parity-provider.cjs')] }
        )
        await waitForPing(url, server)
        const { cookie, status } = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: auth })
        assert.equal(status, 200)
        assert.ok(cookie)
        async function post(route, body) {
            const r = await request(url + '/api/v1/' + route, { method: 'POST', body, cookie, timeoutMs: 45000 })
            assert.ok(r.status >= 200 && r.status < 300, route + ' returned ' + r.status + ' ' + (r.json?.message || ''))
            return r.json
        }
        const credential = await post('credentials', {
            name: 'Local shift simulation',
            credentialName: 'xaiApi',
            plainDataObj: { xaiApiKey: modelKey }
        })
        const packs = randomInt(12, 38),
            units = randomInt(4, 10)
        const graph = shiftCanvas(credential.id, packs, units)
        await post('chatflows', { name, type: 'HARNESS', flowData: JSON.stringify(graph), deployed: false, isPublic: false })
        const route = 'harnesses/' + name + '/runs'
        const rejected = await request(url + '/api/v1/' + route, { method: 'POST', body: { question: 'Reconcile this shift.' } })
        assert.ok([401, 403].includes(rejected.status))
        for (const mode of ['router', 'agent']) {
            const ticket = 'T-' + randomUUID().replaceAll('-', '').slice(0, 12)
            const run = await post(route, {
                mode,
                chatId: randomUUID(),
                question: `Reconcile dispatch for ticket ${ticket}. Include every assigned check.`
            })
            assert.equal(run.trace.engine, 'native')
            const actual = Object.fromEntries(run.agents.map((a) => [a.name, a]))
            assert.equal(run.agents.length, 3)
            assert.deepEqual(Object.keys(actual).sort(), ['clerk', 'inventory', 'operator'])
            if (mode === 'agent')
                assert.deepEqual(
                    run.agents.map((role) => role.name),
                    ['inventory', 'operator', 'clerk']
                )
            for (const role of Object.values(actual)) assert.equal(role.status, 'completed', role.error)
            assert.equal(run.text, `Closed ${ticket} with ${packs * units} counted units and verified status.`)
            const csv = run.artifacts.find((x) => x.name?.endsWith('handoff.csv'))
            assert.ok(csv, 'The clerk must emit its completed public artifact.')
            const expected = mode === 'agent' ? `${ticket},${packs * units},ready` : `${ticket},pending review`
            assert.equal(Buffer.from(csv.base64, 'base64').toString(), expected)
            for (const [who, tools] of Object.entries({
                inventory: ['skills_list', 'skill_view', 'calculator'],
                operator: ['ops_status'],
                clerk: ['read_file', 'write_file']
            })) {
                const receipts = actual[who].tools.map((receipt) =>
                    typeof receipt === 'string' ? receipt : receipt.name + ' ' + receipt.status
                )
                for (const tool of tools) assert.ok(receipts.includes(tool + ' done'), who + ' lacks ' + tool + ' receipt: ' + receipts)
                for (const receipt of receipts)
                    assert.ok(tools.includes(receipt.split(' ')[0]), who + ' used an unassigned tool: ' + receipt)
            }
        }
        const partial = await post(route, {
            mode: 'agent',
            chatId: randomUUID(),
            question: 'T-123456abcdef check incomplete handoff'
        })
        assert.equal(partial.text, `Counted ${packs * units} units. The clerk failed.`)
        assert.deepEqual(
            partial.agents.map((a) => [a.name, a.status]),
            [
                ['inventory', 'completed'],
                ['clerk', 'failed']
            ]
        )
        assert.match(partial.agents[1].error, /empty answer/)
        assert.deepEqual(partial.artifacts, [])
    }
)
